import { describe, expect, it } from 'vitest';
import { pantryItemsFromPages } from '../src/shopping';

describe('pantry items out of a photographed receipt or list', () => {
  it('reads a grocery receipt down to the things bought', () => {
    const receipt = [
      'WHOLE FOODS MARKET',
      '1234 MAIN ST AUSTIN TX',
      '(512) 555-0100',
      '10/01/2026 14:32',
      'ORG BANANAS 1.23 LB @ 0.59 /LB 0.73 F',
      '4011 AVOCADOS 2 @ 1.50 3.00 F',
      'WHOLE MILK 4.99 F',
      'SHARP CHEDDAR 5.49 F',
      'EGGS LARGE DOZEN $3.29',
      'SUBTOTAL 17.50',
      'TAX 0.00',
      'TOTAL 17.50',
      'VISA ************1234 17.50',
      'CHANGE DUE 0.00',
      'THANK YOU FOR SHOPPING',
    ].join('\n');
    expect(pantryItemsFromPages([receipt])).toEqual([
      'bananas', 'avocados', 'whole milk', 'sharp cheddar', 'eggs large dozen',
    ]);
  });

  it('turns OCR from a photographed paper receipt into pantry items', () => {
    // Captured from the app's tesseract.js engine using the CC0 sample receipt
    // photo at https://filedone.ai/sample-files/sample-receipt. The document is
    // fictional, but the image is a phone-style photo of a printed receipt.
    const photoOcr = [
      'CORNER CAFE :',
      '(a fictional cafe)',
      '3 Example Street, Sampleton',
      'Tax no. : SPECIMEN-TAX-0003',
      'Receipt 2026-0918-p457',
      '18/09/2026 08:42 Till 2',
      '2 x Masala chai * : ‘89.89',
      '1 X Filter coffee 55.00',
      '2 Xx Veg sandwich 180.00',
      '1 x Banana bread slice 65.00',
      'TOTAL 380.00',
      'incl. GST 5% 18.10',
      'Paid by carqg 380.00',
      'Thank you, see you again!',
      'SPECIMEN - fictional receipt',
      'made by filedone.aji for testing',
      'Free to use (cco 1.0)',
    ].join('\n');

    expect(pantryItemsFromPages([photoOcr])).toEqual([
      'Masala chai', 'Filter coffee', 'Veg sandwich', 'Banana bread slice',
    ]);
  });

  it('reads a written list, keeping the name and dropping the measure', () => {
    const list = ['Ingredients', '- 2 cups flour', '• 1 tsp salt', '[ ] butter, softened', '3) olive oil for frying', 'Sugar'].join('\n');
    expect(pantryItemsFromPages([list])).toEqual(['flour', 'salt', 'butter', 'olive oil', 'Sugar']);
  });

  it('splits a comma list into its things, but not a line carrying a note', () => {
    expect(pantryItemsFromPages(['Ingredients: rice, black beans, cumin, garlic'])).toEqual(['rice', 'black beans', 'cumin', 'garlic']);
    expect(pantryItemsFromPages(['2 cups flour, sifted'])).toEqual(['flour']);
  });

  it('leaves out what the pantry already has, and a repeat within the photo', () => {
    // 'granulated sugar' IS the sugar on the shelf — the pantry's own reading.
    expect(pantryItemsFromPages(['MILK 2.99\nMILK 2.99\ngranulated sugar\nonions'], ['Sugar', '1 lb onions'])).toEqual(['milk']);
  });

  it('drops speckle, barcodes and blank lines', () => {
    expect(pantryItemsFromPages(['\n  \n0123456789012\n~ .. ,\nab\n'])).toEqual([]);
  });
});
