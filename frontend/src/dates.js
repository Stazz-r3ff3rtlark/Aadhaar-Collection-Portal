// Dates are shown as DD/MM/YYYY and times in IST everywhere, whatever the device timezone.

const IST = 'Asia/Kolkata';

const dateParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function parts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Object.fromEntries(dateParts.formatToParts(date).map((p) => [p.type, p.value]));
}

/** DD/MM/YYYY in IST, or an empty string. Calendar dates ('YYYY-MM-DD') are shown as they are. */
export function formatDate(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-');
    return `${d}/${m}/${y}`;
  }
  const p = value == null ? null : parts(value);
  return p ? `${p.day}/${p.month}/${p.year}` : '';
}

/** DD/MM/YYYY HH:MM IST, or an empty string. */
export function formatDateTime(value) {
  const p = value == null ? null : parts(value);
  return p ? `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute} IST` : '';
}
