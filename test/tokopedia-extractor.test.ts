import { extractTokopediaPriceAndStock } from '../src/handler';

describe('extractTokopediaPriceAndStock', () => {
  it('parses price from Tokopedia paylater URL parameter', () => {
    const html = `
      <html>
        <body>
          <a href="tokopedia://fintech/paylater?category=iOS&price=24479000.000000&productID=123">Paylater</a>
        </body>
      </html>
    `;

    const { price, inStock } = extractTokopediaPriceAndStock(html);

    expect(price).toBe(24479000);
    expect(inStock).toBeNull();
  });

  it('falls back to Rp-formatted price text', () => {
    const html = `
      <html>
        <body>
          <span>Rp30.999.000</span>
        </body>
      </html>
    `;

    const { price } = extractTokopediaPriceAndStock(html);

    expect(price).toBe(30999000);
  });

  it('detects in-stock quantity from "Stok: N"', () => {
    const html = `
      <html>
        <body>
          <p>Stok: 30</p>
        </body>
      </html>
    `;

    const { inStock } = extractTokopediaPriceAndStock(html);

    expect(inStock).toBe(true);
  });

  it('detects out-of-stock text variants', () => {
    const html = `
      <html>
        <body>
          <p>Stok habis</p>
        </body>
      </html>
    `;

    const { inStock } = extractTokopediaPriceAndStock(html);

    expect(inStock).toBe(false);
  });
});
