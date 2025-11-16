import { extractAmazonPriceAndStock } from '../src/handler';

describe('extractAmazonPriceAndStock', () => {
	it('parses price from desktop_buybox_group_1 JSON blob', () => {
			const html = `
			  {"desktop_buybox_group_1":[{"displayPrice":"IDR 501,282.85","priceAmount":501282.85}]}
			`;
	
			const { price } = extractAmazonPriceAndStock(html);
		
			expect(price).toBe(501282.85);
		});
	
	it('falls back to Product Summary / One-time purchase text', () => {
			const html = `
			  <div>Product Summary: Best bottle ever. One-time purchase: IDR 501,282.85</div>
			`;
	
			const { price } = extractAmazonPriceAndStock(html);
			expect(price).toBe(501282.85);
		});

	it('parses USD price with decimals, e.g. $29.99', () => {
			const html = `
			  {"desktop_buybox_group_1":[{"displayPrice":"USD 29.99","priceAmount":29.99}]}
			`;
		
			const { price } = extractAmazonPriceAndStock(html);
			expect(price).toBe(29.99);
		});

	it('detects "In Stock" text as inStock = true', () => {
			const html = `
			  <span>In Stock</span>
			`;
			const { inStock } = extractAmazonPriceAndStock(html);
			expect(inStock).toBe(true);
		});

	it('detects "Currently unavailable" text as inStock = false', () => {
			const html = `
			  <div>Currently unavailable.</div>
			`;
			const { inStock } = extractAmazonPriceAndStock(html);
			expect(inStock).toBe(false);
		});
});
