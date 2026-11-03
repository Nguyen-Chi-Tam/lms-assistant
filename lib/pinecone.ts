import { Pinecone } from '@pinecone-database/pinecone';

const apiKey = process.env.PINECONE_API_KEY || '';
const indexName = process.env.PINECONE_INDEX_NAME || '';

if (!apiKey || !indexName) {
  throw new Error('PINECONE_API_KEY and PINECONE_INDEX_NAME must be configured.');
}

export const pinecone = new Pinecone({ apiKey });

export function getPineconeIndex() {
  return pinecone.Index(indexName);
}
