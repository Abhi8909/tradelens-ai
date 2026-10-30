import { exportMtfCsv } from './csv.ts';
/** Entirely invented spreadsheet, unrelated to the user's private reference. */
export function syntheticMtfImportCsv(): string {
  const headers = ['Scrip', 'Buy Date', 'No of Days', 'Per day', 'Intreset Till Now', 'Other Charges', 'Total charges', 'Buy Price', 'No of Shares', 'New Buy Price', 'Current Price', 'Invested amount', 'Final Total Amount (Charges + Investment)', 'Unreleased P/L', 'Percent', 'Sell Price', 'Exit Date', 'P/L', '', ''];
  const rows = Array.from({ length: 9 }, (_, i) => {
    const badExit = i >= 6;
    return [`SYN-LOT-${i + 1}`, badExit ? '08/20/2025' : `06/${String(10 + i).padStart(2, '0')}/2025`, '30', '2.50', '75', '5', '80', '50', '10', '58', i === 4 ? '#N/A' : '60', '500', '580', '20', '3.45%', badExit ? '60' : '', badExit ? '08/01/2025' : '', '', i === 6 ? 'Converted to delivery' : '', ''];
  });
  return exportMtfCsv([headers, ...rows, [], ['', 'TOTAL', '', '', '', '', '', '', '', '', '', '4500']]);
}
