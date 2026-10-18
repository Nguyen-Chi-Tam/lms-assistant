-- ==============================================================================
-- LMS Assistant - Supabase pgvector Setup & HNSW Indexing
-- Run this script in the Supabase SQL Editor (Dashboard -> SQL Editor -> New Query)
-- ==============================================================================

-- 1. Ensure the pgvector extension is activated
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Create B-Tree indexes for ultra-fast filtering by Course and File ID
CREATE INDEX IF NOT EXISTS idx_doc_embeddings_course_id 
ON document_embeddings(moodle_course_id);

CREATE INDEX IF NOT EXISTS idx_doc_embeddings_file_id 
ON document_embeddings(moodle_file_id);

-- 3. Create HNSW (Hierarchical Navigable Small World) index for sub-millisecond Cosine distance search
CREATE INDEX IF NOT EXISTS idx_doc_embeddings_hnsw 
ON document_embeddings USING hnsw (embedding vector_cosine_ops);

-- 4. Create Postgres RPC function for native database-level similarity search
CREATE OR REPLACE FUNCTION match_document_embeddings (
  query_embedding vector(768),
  match_threshold float,
  match_count int,
  filter_course_id int
)
RETURNS TABLE (
  id uuid,
  moodle_course_id int,
  moodle_file_id int,
  document_title varchar,
  page_number int,
  chunk_text text,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    de.id,
    de.moodle_course_id,
    de.moodle_file_id,
    de.document_title,
    de.page_number,
    de.chunk_text,
    (1 - (de.embedding <=> query_embedding))::float AS similarity
  FROM document_embeddings de
  WHERE de.moodle_course_id = filter_course_id
    AND de.embedding IS NOT NULL
    AND 1 - (de.embedding <=> query_embedding) > match_threshold
  ORDER BY de.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
