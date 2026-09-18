ALTER TABLE source_files
  ADD COLUMN status_reason text;

UPDATE source_files sf
   SET status_reason = COALESCE((
    SELECT failure_reason
      FROM source_extractions
     WHERE source_id = sf.id AND failure_reason IS NOT NULL
     ORDER BY created_at DESC, id DESC
     LIMIT 1
  ), 'Motif historique indisponible.')
 WHERE sf.status IN ('NON_TRAITE', 'FAILED');

ALTER TABLE source_files
  ADD CONSTRAINT source_files_status_reason_check CHECK (
    (status IN ('NON_TRAITE', 'FAILED') AND status_reason IS NOT NULL
      AND length(trim(status_reason)) > 0)
    OR (status IN ('RECEIVED', 'PROCESSING', 'DONE') AND status_reason IS NULL)
  );

CREATE TABLE source_observation_inputs (
  source_id uuid NOT NULL REFERENCES source_observations(source_id) ON DELETE CASCADE,
  extraction_id uuid NOT NULL REFERENCES source_extractions(id) ON DELETE RESTRICT,
  PRIMARY KEY (source_id, extraction_id)
);

INSERT INTO source_observation_inputs (source_id, extraction_id)
SELECT source_id, extraction_id FROM source_observations;
