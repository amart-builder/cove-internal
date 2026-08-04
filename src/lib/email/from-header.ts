// Pure RFC 5322 From-header splitting for contact resolution. The raw header
// ('"Sarah Chen" <sarah@work.com>') must never be used as a contact name:
// the welded form defeats the CRM ambiguity guard and creates duplicates.

export type ParsedFromHeader = {
  displayName: string;
  address: string;
};

function decodeEncodedWord(token: string): string {
  const match = /^=\?([^?]+)\?([bq])\?([^?]*)\?=$/i.exec(token);
  if (!match) return token;
  const [, rawCharset, encoding, payload] = match;
  try {
    let bytes: Buffer;
    if (encoding.toLowerCase() === "b") {
      bytes = Buffer.from(payload, "base64");
    } else {
      const decoded: number[] = [];
      for (let index = 0; index < payload.length; index += 1) {
        const character = payload[index];
        if (character === "_") {
          decoded.push(0x20);
        } else if (
          character === "=" &&
          /^[0-9a-f]{2}$/i.test(payload.slice(index + 1, index + 3))
        ) {
          decoded.push(Number.parseInt(payload.slice(index + 1, index + 3), 16));
          index += 2;
        } else {
          decoded.push(character.charCodeAt(0));
        }
      }
      bytes = Buffer.from(decoded);
    }
    const charset = rawCharset.toLowerCase();
    const text = charset.includes("8859") || charset.includes("latin")
      ? bytes.toString("latin1")
      : bytes.toString("utf8");
    // A charset this helper cannot represent falls back to the raw token.
    return text.includes("�") ? token : text;
  } catch {
    return token;
  }
}

function decodeEncodedWords(value: string): string {
  return value
    .replace(/=\?[^?\s]+\?[bq]\?[^?\s]*\?=/gi, decodeEncodedWord)
    .replace(/\s+/g, " ")
    .trim();
}

export function parseFromHeader(value: string): ParsedFromHeader {
  const raw = value.trim();
  let name = "";
  let comment = "";
  let angleAddress: string | null = null;
  let index = 0;
  while (index < raw.length) {
    const character = raw[index];
    if (character === '"') {
      index += 1;
      while (index < raw.length && raw[index] !== '"') {
        if (raw[index] === "\\" && index + 1 < raw.length) {
          name += raw[index + 1];
          index += 2;
        } else {
          name += raw[index];
          index += 1;
        }
      }
      index += 1;
    } else if (character === "(") {
      let depth = 1;
      index += 1;
      let text = "";
      while (index < raw.length && depth > 0) {
        if (raw[index] === "(") depth += 1;
        else if (raw[index] === ")") depth -= 1;
        if (depth > 0) text += raw[index];
        index += 1;
      }
      comment = comment ? `${comment} ${text}` : text;
    } else if (character === "<" && angleAddress === null) {
      const end = raw.indexOf(">", index + 1);
      if (end === -1) {
        angleAddress = raw.slice(index + 1);
        index = raw.length;
      } else {
        angleAddress = raw.slice(index + 1, end);
        index = end + 1;
      }
    } else {
      name += character;
      index += 1;
    }
  }
  name = decodeEncodedWords(name);
  comment = decodeEncodedWords(comment);

  let address: string;
  if (angleAddress !== null) {
    address = angleAddress.trim().toLowerCase();
  } else if (name.includes("@")) {
    // Bare form: the whole value is the address, never a display name.
    address = name.toLowerCase();
    name = "";
  } else {
    address = "";
  }
  if (!name) name = comment;
  if (!name && address) {
    const localPart = address.split("@", 1)[0].trim();
    name = localPart || address;
  }
  return { displayName: name, address };
}
