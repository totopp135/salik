// Normalizes a plate: uppercase, removes spaces/dashes, converts Arabic digits to 0-9
function normalizePlate(input) {
  const arabicDigits = '٠١٢٣٤٥٦٧٨٩';
  return String(input || '')
    .replace(/[٠-٩]/g, (d) => String(arabicDigits.indexOf(d)))
    .replace(/[\s\-_.]/g, '')
    .toUpperCase();
}
module.exports = { normalizePlate };
