// Generates a clean, familiar-looking receipt image after a successful
// payment — designed to look like something a Nigerian bank app or
// Opay/PalmPay would send, since that's the visual language someone with
// zero crypto background already trusts.
//
// Uses @napi-rs/canvas with a font file bundled directly in this repo
// (fonts/DejaVuSans*.ttf), rather than relying on the host server having
// any fonts installed. This matters: an earlier version used SVG text
// rendering, which silently produced blank boxes instead of letters on a
// production server that had zero system fonts available. Bundling the
// font file removes that dependency entirely — this works identically
// wherever it runs.

import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FONT_REGULAR = 'Sendo Sans';
const FONT_BOLD = 'Sendo Sans Bold';

let fontsRegistered = false;
function ensureFontsRegistered() {
  if (fontsRegistered) return;
  GlobalFonts.registerFromPath(join(__dirname, '..', 'fonts', 'DejaVuSans.ttf'), FONT_REGULAR);
  GlobalFonts.registerFromPath(join(__dirname, '..', 'fonts', 'DejaVuSans-Bold.ttf'), FONT_BOLD);
  fontsRegistered = true;
}

let cachedLogo = null;
async function getLogo() {
  if (!cachedLogo) {
    cachedLogo = await loadImage(join(__dirname, '..', 'assets', 'logo.png'));
  }
  return cachedLogo;
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
  ensureFontsRegistered();
  const logo = await getLogo();

  const width = 600;
  const rowHeight = 44;
  const headerHeight = 375;
  const footerHeight = 90;
  const height = headerHeight + rows.length * rowHeight + footerHeight;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Outer background
  ctx.fillStyle = '#f5f5f7';
  ctx.fillRect(0, 0, width, height);

  // Card
  const cardRadius = 20;
  const cardX = 20, cardY = 20, cardW = width - 40, cardH = height - 40;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.roundRect(cardX, cardY, cardW, cardH, cardRadius);
  ctx.fill();

  // Sendo logo — rounded-square badge so the logo's dark background reads
  // as an intentional icon treatment, same style as an app icon.
  const logoSize = 56;
  const logoX = width / 2 - logoSize / 2;
  const logoY = 36;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(logoX, logoY, logoSize, logoSize, 14);
  ctx.clip();
  ctx.drawImage(logo, logoX, logoY, logoSize, logoSize);
  ctx.restore();

  // Sendo wordmark
  ctx.fillStyle = '#16a34a';
  ctx.font = `16px "${FONT_BOLD}"`;
  ctx.textAlign = 'center';
  ctx.fillText('Sendo', width / 2, logoY + logoSize + 26);

  // Success circle + checkmark
  const checkY = 220;
  ctx.fillStyle = '#e8f9ee';
  ctx.beginPath();
  ctx.arc(width / 2, checkY, 34, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#16a34a';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(width / 2 - 14, checkY);
  ctx.lineTo(width / 2 - 4, checkY + 10);
  ctx.lineTo(width / 2 + 14, checkY - 10);
  ctx.stroke();

  // Title
  ctx.fillStyle = '#6b7280';
  ctx.font = `16px "${FONT_REGULAR}"`;
  ctx.textAlign = 'center';
  ctx.fillText(title, width / 2, checkY + 65);

  // Amount
  ctx.fillStyle = '#111827';
  ctx.font = `38px "${FONT_BOLD}"`;
  ctx.fillText(`NGN ${formatAmount(amount)}`, width / 2, checkY + 110);

  // Divider above rows
  ctx.strokeStyle = '#f0f0f0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, headerHeight - 10);
  ctx.lineTo(width, headerHeight - 10);
  ctx.stroke();

  // Detail rows
  rows.forEach((row, i) => {
    const y = headerHeight + i * rowHeight + 30;

    ctx.fillStyle = '#6b7280';
    ctx.font = `15px "${FONT_REGULAR}"`;
    ctx.textAlign = 'left';
    ctx.fillText(row.label, 40, y);

    ctx.fillStyle = '#111827';
    ctx.font = `15px "${FONT_BOLD}"`;
    ctx.textAlign = 'right';
    ctx.fillText(row.value, width - 40, y);

    if (i < rows.length - 1) {
      ctx.strokeStyle = '#f0f0f0';
      ctx.beginPath();
      ctx.moveTo(40, y + 20);
      ctx.lineTo(width - 40, y + 20);
      ctx.stroke();
    }
  });

  // Divider below rows
  const rowsBottom = headerHeight + rows.length * rowHeight + 10;
  ctx.strokeStyle = '#f0f0f0';
  ctx.beginPath();
  ctx.moveTo(0, rowsBottom);
  ctx.lineTo(width, rowsBottom);
  ctx.stroke();

  // Footer
  ctx.fillStyle = '#9ca3af';
  ctx.font = `13px "${FONT_REGULAR}"`;
  ctx.textAlign = 'center';
  ctx.fillText(formatDateTime(new Date()), width / 2, height - 45);

  ctx.fillStyle = '#c4c8ce';
  ctx.font = `12px "${FONT_REGULAR}"`;
  ctx.fillText(`Ref: ${reference} · Sendo`, width / 2, height - 25);

  return canvas.toBuffer('image/png');
}
