import type { ScheduledEvent, Context } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import axios from 'axios';

const PRODUCTS_TABLE = process.env.PRODUCTS_TABLE || '';
const USERS_TABLE = process.env.USERS_TABLE || '';
const SNS_PRICE_DROP_TOPIC_ARN = process.env.SNS_PRICE_DROP_TOPIC_ARN || '';
const SNS_STOCK_RESTOCK_TOPIC_ARN = process.env.SNS_STOCK_RESTOCK_TOPIC_ARN || '';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sns = new SNSClient({});

export async function handler(
  _event: ScheduledEvent | undefined,
  _context: Context,
) {
  if (!PRODUCTS_TABLE || !USERS_TABLE) {
    throw new Error('PRODUCTS_TABLE and USERS_TABLE env vars are required');
  }

	  console.log('Amazon scraper start', {
    PRODUCTS_TABLE,
    USERS_TABLE,
    hasPriceTopic: !!SNS_PRICE_DROP_TOPIC_ARN,
    hasStockTopic: !!SNS_STOCK_RESTOCK_TOPIC_ARN,
  });

  let processed = 0;
  let ExclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const scan = await ddb.send(
      new ScanCommand({ TableName: PRODUCTS_TABLE, ExclusiveStartKey }),
    );

    ExclusiveStartKey = scan.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;
    const items = (scan.Items || []) as Array<Record<string, any>>;

    for (const item of items) {
      processed++;
      const productUrl = item.product_url as string | undefined;
      const userId = item.user_id as string | undefined;
      const lastPrice =
        typeof item.last_price === 'number'
          ? (item.last_price as number)
          : undefined;
      const prevInStock =
        typeof item.in_stock === 'boolean' ? (item.in_stock as boolean) : false;

      if (!productUrl || !userId) {
        console.warn('Skipping product with missing url/user_id', item);
        continue;
      }

	      try {
	        console.log('Checking product', { productUrl, userId, lastPrice });
	
		        const response = await axios.get<string>(productUrl, {
		          headers: {
		            'User-Agent':
		              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
		              '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
		            // Use an English locale so Amazon serves a consistent layout
		            'Accept-Language': 'en-US,en;q=0.9',
		          },
		        });
		
		        const { price, inStock } = extractAmazonPriceAndStock(response.data);

        if (price == null) {
          console.warn('Could not extract price from page, skipping', {
            productUrl,
          });
          continue;
        }

        const nowInStock = inStock ?? prevInStock;
        const priceDropped = lastPrice != null && price < lastPrice;
        const restocked = prevInStock === false && nowInStock === true;

        if (priceDropped || restocked) {
          const user = await ddb.send(
            new GetCommand({
              TableName: USERS_TABLE,
              Key: { user_id: userId },
            }),
          );

          const email = (user.Item?.email as string | undefined) || 'unknown';

	          if (priceDropped && SNS_PRICE_DROP_TOPIC_ARN) {
            const msg = `Harga turun untuk produk ${productUrl}. ` +
              `Harga sebelumnya: ${lastPrice ?? 'unknown'}, sekarang: ${price}. ` +
              `User: ${userId}, email: ${email}.`;

	            await sns.send(
	              new PublishCommand({
	                TopicArn: SNS_PRICE_DROP_TOPIC_ARN,
		                Subject: 'Price Drop Alert (Amazon)',
	                Message: msg,
	              }),
	            );
          }

          if (restocked && SNS_STOCK_RESTOCK_TOPIC_ARN) {
            const msg = `Stok kembali tersedia untuk produk ${productUrl}. ` +
              `User: ${userId}, email: ${email}.`;

	            await sns.send(
	              new PublishCommand({
	                TopicArn: SNS_STOCK_RESTOCK_TOPIC_ARN,
		                Subject: 'Stock Restock Alert (Amazon)',
	                Message: msg,
	              }),
	            );
          }
        }

        await ddb.send(
          new UpdateCommand({
            TableName: PRODUCTS_TABLE,
            Key: { product_url: productUrl },
            UpdateExpression:
              'SET last_price = :price, in_stock = :inStock, updated_at = :now',
            ExpressionAttributeValues: {
              ':price': price,
              ':inStock': nowInStock,
              ':now': new Date().toISOString(),
            },
          }),
        );
      } catch (err) {
        console.error('Error processing product', { productUrl, err });
      }
    }
  } while (ExclusiveStartKey);

		  console.log('Amazon scraper finished', { processed });
	}

export function extractLazadaPriceAndStock(html: string): {
	  price: number | null;
	  inStock: boolean | null;
	} {
	  let price: number | null = null;

	  try {
	    const trackingMatch =
	      html.match(/var\s+pdpTrackingData\s*=\s*"([^"]*)"/) ||
	      html.match(/var\s+pdpTrackingData\s*=\s*'([^']*)'/);
	    if (trackingMatch) {
	      const jsonStr = trackingMatch[1];
	      console.log('Lazada tracking snippet', jsonStr.slice(0, 200));
	      const tracking = JSON.parse(jsonStr);
	      if (tracking && typeof tracking.pdt_price === 'string') {
	        const digits = tracking.pdt_price.replace(/[^\d]/g, '');
	        const parsed = parseInt(digits, 10);
	        if (!Number.isNaN(parsed)) {
	          price = parsed;
	        }
	      }
	    }
	  } catch {
	  }

	  if (price == null) {
	    const escapedMatch = html.match(/pdt_price\":\"([^\"]+)\"/);
	    const plainMatch = html.match(/"pdt_price":"([^"]+)"/);
	    const rawPrice =
	      (escapedMatch && escapedMatch[1]) || (plainMatch && plainMatch[1]);
	    if (rawPrice) {
	      const digits = rawPrice.replace(/[^\d]/g, '');
	      const parsed = parseInt(digits, 10);
	      if (!Number.isNaN(parsed)) price = parsed;
	    }
	  }

	  let inStock: boolean | null = null;
	  if (/Stok habis/i.test(html)) {
	    inStock = false;
	  } else if (/schema\.org\/InStock/i.test(html)) {
	    inStock = true;
	  }

	  return { price, inStock };
	}
		

export function extractAmazonPriceAndStock(html: string): {
		  price: number | null;
		  inStock: boolean | null;
		} {
		  let price: number | null = null;
		
		  try {
		    const amountMatch = html.match(/"priceAmount"\s*:\s*([0-9.]+)/);
		    if (amountMatch) {
		      const parsed = parseFloat(amountMatch[1]);
		      if (!Number.isNaN(parsed)) {
		        price = parsed;
		      }
		    }
		  } catch {
		  }
		
		  if (price == null) {
		    const buyBoxMatch = html.match(
		      /"desktop_buybox_group_1"\s*:\s*\[\{"displayPrice":"([^"]+)"/,
		    );
		    if (buyBoxMatch) {
		      const displayPrice = buyBoxMatch[1];
		      const cleaned = displayPrice.replace(/[^0-9.,]/g, '');
		      const normalized = cleaned.replace(/,/g, '');
		      const parsed = parseFloat(normalized);
		      if (!Number.isNaN(parsed)) {
		        price = parsed;
		      }
		    }
		  }
		
		  if (price == null) {
		    const summaryMatch = html.match(
		      /Product Summary:[\s\S]{0,200}?One-time purchase:\s*([^<\n]+)/,
		    );
		    if (summaryMatch) {
		      const rawPrice = summaryMatch[1];
		      const cleaned = rawPrice.replace(/[^0-9.,]/g, '');
		      const normalized = cleaned.replace(/,/g, '');
		      const parsed = parseFloat(normalized);
		      if (!Number.isNaN(parsed)) {
		        price = parsed;
		      }
		    }
		  }
		
		  let inStock: boolean | null = null;
		  if (/In Stock/i.test(html)) {
		    inStock = true;
		  } else if (/Currently unavailable/i.test(html)) {
		    inStock = false;
		  }
		
		  return { price, inStock };
		}
		