-- CardMint Sync Extension: Bootstrap Migration v1.0.0
-- Creates the cardmint_variant_tags attribute for bidirectional variant sync
-- This migration runs automatically when the extension is first loaded

-- Create the cardmint_variant_tags attribute if it doesn't exist
-- Using DO block for idempotent execution (safe to re-run)
DO $$
DECLARE
  attr_id integer;
BEGIN
  -- Check if attribute already exists
  SELECT attribute_id INTO attr_id
  FROM attribute
  WHERE attribute_code = 'cardmint_variant_tags';

  IF attr_id IS NULL THEN
    -- Create the attribute
    INSERT INTO attribute (
      attribute_code,
      attribute_name,
      type,
      is_required,
      display_on_frontend,
      sort_order,
      is_filterable
    ) VALUES (
      'cardmint_variant_tags',
      'Variant Tags',
      'text',
      false,
      true,
      10,
      false
    )
    RETURNING attribute_id INTO attr_id;

    -- Link to default attribute group (group_id=1)
    INSERT INTO attribute_group_link (attribute_id, group_id)
    VALUES (attr_id, 1);

    RAISE NOTICE '[cardmint_sync] Created cardmint_variant_tags attribute (id=%)', attr_id;
  ELSE
    RAISE NOTICE '[cardmint_sync] cardmint_variant_tags attribute already exists (id=%)', attr_id;
  END IF;
END $$;
