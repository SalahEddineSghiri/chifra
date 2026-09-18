ALTER TABLE batches
  ADD COLUMN name text CHECK (name IS NULL OR length(trim(name)) BETWEEN 1 AND 120);
