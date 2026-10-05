interface BaseItem { id: string; createdAt: number }
export interface TextItem extends BaseItem { type: 'text'; text: string; decryptionError?: boolean }
export interface EncryptedTextItem extends BaseItem { type: 'text'; envelope: string }
export interface FileItem extends BaseItem {
  type: 'file'; name: string; size: number; mimeType: string; url: string;
  envelope: string; decryptionError?: boolean; previewUrl?: string;
}
export interface EncryptedFileItem extends BaseItem { type: 'file'; envelope: string; url: string; ciphertextSize: number }
export type DropItem = TextItem | FileItem;
export interface ItemPage { items: DropItem[]; nextCursor: string | null }
export interface EncryptedItemPage { items: (EncryptedTextItem | EncryptedFileItem)[]; nextCursor: string | null }
export const DEFAULT_PAGE_SIZE = 5;
export const MAX_PAGE_SIZE = 50;
export const MAX_FILE_SIZE = 100 * 1024 * 1024;
export const MAX_CIPHERTEXT_SIZE = MAX_FILE_SIZE + 20 * 100 + 92;
export const BROWSER_FILE_LIMIT = 8 * 1024 * 1024;
