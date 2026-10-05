import type { TextItem } from './model';

export async function copyTextItem(item: TextItem, clipboard: { writeText(text: string): Promise<void> }) {
  if (item.decryptionError) throw new Error('This text could not be decrypted.');
  await clipboard.writeText(item.text);
}
