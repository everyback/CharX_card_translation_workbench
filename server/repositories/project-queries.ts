export const PROJECT_TITLE_COLUMNS = `
  p.name AS originalName,
  (
    SELECT COALESCE(NULLIF(TRIM(title.final_text), ''), NULLIF(TRIM(title.translated_text), ''))
    FROM segments title
    WHERE title.project_id = p.id
      AND (
        (p.source_format = 'risum' AND title.path_json = '["$module","name"]')
        OR (
          p.source_format <> 'risum'
          AND title.path_json IN ('["name"]', '["data","name"]')
        )
      )
      AND COALESCE(NULLIF(TRIM(title.final_text), ''), NULLIF(TRIM(title.translated_text), '')) IS NOT NULL
    ORDER BY
      CASE title.path_json
        WHEN '["name"]' THEN 0
        WHEN '["data","name"]' THEN 1
        ELSE 2
      END,
      CASE WHEN NULLIF(TRIM(title.final_text), '') IS NOT NULL THEN 0 ELSE 1 END
    LIMIT 1
  ) AS translatedName
`;
