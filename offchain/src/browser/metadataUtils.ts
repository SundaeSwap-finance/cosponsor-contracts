import { Core } from "@blaze-cardano/sdk";

/**
 * CIP-25 metadata has a 64-byte limit per text field. Values that exceed this
 * limit must be split into an array of 64-byte chunks (a MetadatumList of text
 * entries).
 *
 * If the value fits in a single chunk, returns a plain text Metadatum.
 * Otherwise returns a MetadatumList of text chunks, each ≤ 64 bytes UTF-8.
 *
 * The inner loop handles multibyte UTF-8 characters: it shrinks each chunk
 * until its byte length is ≤ 64, so that no character is split across chunks.
 */
export const chunkCip25Text = (value: string): Core.Metadatum => {
  if (Buffer.from(value, "utf8").length <= 64) {
    return Core.Metadatum.newText(value);
  }

  const chunks = new Core.MetadatumList();
  for (let i = 0; i < value.length; i += 64) {
    let shrink = 0;
    while (
      Buffer.from(value.substring(i, i + 64 - shrink), "utf8").length > 64
    ) {
      shrink++;
    }
    chunks.add(Core.Metadatum.newText(value.substring(i, i + 64 - shrink)));
    i -= shrink;
  }

  return Core.Metadatum.newList(chunks);
};
