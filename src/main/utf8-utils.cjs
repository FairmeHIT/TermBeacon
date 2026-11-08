// Keep a bounded UTF-8 tail without decoding a partial leading character.
function utf8Tail(value, maxBytes) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return bytes.toString("utf8");
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

module.exports = { utf8Tail };
