// Generates a clean, familiar-looking receipt image after a successful
// payment — designed to look like something a Nigerian bank app or
// Opay/PalmPay would send, since that's the visual language someone with
// zero crypto background already trusts. Built as an SVG template
// rendered to PNG, so it can be sent as a real photo in Telegram that
// anyone can screenshot, download, or forward.
//
// Deliberately uses "NGN" instead of the ₦ symbol — the server environment
// isn't guaranteed to have a font with that glyph installed, and a missing
// character would render as a broken box instead of a currency sign.

import sharp from 'sharp';

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatAmount(amount) {
  const num = Number(amount);
  return num.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDateTime(date) {
  return date.toLocaleString('en-NG', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// rows: array of { label, value } shown in the detail section
export async function generateReceipt({ title, amount, rows, reference }) {
  const width = 600;
  const rowHeight = 44;
  const headerHeight = 260;
  const footerHeight = 90;
  const height = headerHeight + rows.length * rowHeight + footerHeight;

  const rowsSvg = rows
    .map((row, i) => {
      const y = headerHeight + i * rowHeight + 30;
      return `
        <text x="40" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="15" fill="#6b7280">${escapeXml(row.label)}</text>
        <text x="${width - 40}" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="15" fill="#111827" text-anchor="end" font-weight="600">${escapeXml(row.value)}</text>
        ${i < rows.length - 1 ? `<line x1="40" y1="${y + 20}" x2="${width - 40}" y2="${y + 20}" stroke="#f0f0f0" stroke-width="1"/>` : ''}
      `;
    })
    .join('');

  const detailSectionY = headerHeight;
  const detailSectionHeight = rows.length * rowHeight;

  const svg = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#f5f5f7"/>
      <rect x="20" y="20" width="${width - 40}" height="${height - 40}" rx="20" fill="#ffffff"/>

      <!-- Success icon -->
      <circle cx="${width / 2}" cy="90" r="34" fill="#e8f9ee"/>
      <path d="M ${width / 2 - 14} 90 l 10 10 l 18 -20" stroke="#16a34a" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>

      <text x="${width / 2}" y="150" font-family="Helvetica, Arial, sans-serif" font-size="16" fill="#6b7280" text-anchor="middle">${escapeXml(title)}</text>
      <text x="${width / 2}" y="195" font-family="Helvetica, Arial, sans-serif" font-size="38" font-weight="700" fill="#111827" text-anchor="middle">NGN ${formatAmount(amount)}</text>

      <line x1="0" y1="${detailSectionY - 10}" x2="${width}" y2="${detailSectionY - 10}" stroke="#f0f0f0" stroke-width="1"/>

      ${rowsSvg}

      <line x1="0" y1="${detailSectionY + detailSectionHeight + 10}" x2="${width}" y2="${detailSectionY + detailSectionHeight + 10}" stroke="#f0f0f0" stroke-width="1"/>

      <text x="${width / 2}" y="${height - 45}" font-family="Helvetica, Arial, sans-serif" font-size="13" fill="#9ca3af" text-anchor="middle">${escapeXml(formatDateTime(new Date()))}</text>
      <text x="${width / 2}" y="${height - 25}" font-family="Helvetica, Arial, sans-serif" font-size="12" fill="#c4c8ce" text-anchor="middle">Ref: ${escapeXml(reference)} · Sendo</text>
    </svg>
  `;

  return sharp(Buffer.from(svg)).png().toBuffer();
}
