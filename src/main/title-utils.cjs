const MAX_TITLE_LENGTH = 60;

function normalizeTitleInput(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MAX_TITLE_LENGTH);
}

module.exports = { MAX_TITLE_LENGTH, normalizeTitleInput };
