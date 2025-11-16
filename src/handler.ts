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
import * as cheerio from 'cheerio';

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

  console.log('Tokopedia scraper start', {
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
        typeof item.harga_terakhir === 'number'
          ? (item.harga_terakhir as number)
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
            'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
          },
          timeout: 15000,
        });

        const { price, inStock } = extractTokopediaPriceAndStock(response.data);

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
                Subject: 'Price Drop Alert (Tokopedia)',
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
                Subject: 'Stock Restock Alert (Tokopedia)',
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
              'SET harga_terakhir = :price, in_stock = :inStock, updated_at = :now',
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

  console.log('Tokopedia scraper finished', { processed });
}

function extractTokopediaPriceAndStock(html: string): {
  price: number | null;
  inStock: boolean | null;
} {
  const $ = cheerio.load(html);
  const text = $.text();

  let price: number | null = null;
  const priceMatch = html.match(/price=([0-9]+(?:\.[0-9]+)?)/);
  if (priceMatch) {
    price = Math.round(parseFloat(priceMatch[1]));
  } else {
    const rpMatch = text.match(/Rp\s*([0-9\.]+)/);
    if (rpMatch) {
      const normalized = rpMatch[1].replace(/\./g, '');
      const parsed = parseInt(normalized, 10);
      if (!Number.isNaN(parsed)) price = parsed;
    }
  }

  let inStock: boolean | null = null;
  const stokMatch = text.match(/Stok:\s*([0-9]+)/i);
  if (stokMatch) {
    const qty = parseInt(stokMatch[1], 10);
    if (!Number.isNaN(qty)) inStock = qty > 0;
  } else if (/Stok habis|stok habis|sold out|habis/i.test(text)) {
    inStock = false;
  }

  return { price, inStock };
}
