import { Core } from "@blaze-cardano/sdk";

/**
 * Split a string into chunks each ≤ `maxBytes` UTF-8 bytes, **never splitting
 * a Unicode code point** — surrogate pairs / multibyte emoji stay intact.
 *
 * Replaces the old `for (i += 64) { … i -= shrink }` loops in
 * `metadataUtils.chunkCip25Text` and `Deposit.chunkImageData`, which indexed by
 * UTF-16 code unit and could cut a surrogate pair in half (and had a
 * theoretical non-termination risk under pathological multibyte input).
 * Iterating with `for…of` yields whole code points, so accumulation is safe.
 * (audit H10 / L10)
 *
 * Assumes `maxBytes ≥ 4` (the max UTF-8 length of a single code point).
 */
export const chunkUtf8 = (value: string, maxBytes = 64): string[] => {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return [value];
  }
  const chunks: string[] = [];
  let current = "";
  for (const ch of value) {
    if (Buffer.byteLength(current + ch, "utf8") > maxBytes) {
      chunks.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current !== "") {
    chunks.push(current);
  }
  return chunks;
};

/**
 * CIP-25 metadata caps each text field at 64 UTF-8 bytes. Returns a plain text
 * Metadatum when the value fits, otherwise a MetadatumList of ≤64-byte chunks
 * (split on code-point boundaries via {@link chunkUtf8}).
 */
export const chunkCip25Text = (value: string): Core.Metadatum => {
  if (Buffer.byteLength(value, "utf8") <= 64) {
    return Core.Metadatum.newText(value);
  }
  const list = new Core.MetadatumList();
  for (const chunk of chunkUtf8(value, 64)) {
    list.add(Core.Metadatum.newText(chunk));
  }
  return Core.Metadatum.newList(list);
};
