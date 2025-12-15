-- EverShop Product Import - CardMint Pilot (7 products)
-- Generated: 2025-11-24
-- Direct PostgreSQL insert (bypasses session-based API auth)

BEGIN;

-- 1. Dark Vaporeon - Pokemon Team Rocket #45
INSERT INTO product (sku, price, weight, status, visibility)
VALUES ('PKM-TEAMROCKET-45-LP', 1.50, 0.01, true, true);
WITH p AS (SELECT product_id FROM product WHERE sku = 'PKM-TEAMROCKET-45-LP')
INSERT INTO product_description (product_description_product_id, name, description, url_key, meta_title, meta_description)
SELECT p.product_id,
       'Dark Vaporeon',
       'Dark Vaporeon from Pokemon Team Rocket (#45). Condition: LP (Lightly Played). A sought-after card from the classic Team Rocket expansion.',
       'dark-vaporeon-team-rocket-45',
       'Dark Vaporeon - Pokemon Team Rocket #45 | CardMint',
       'Buy Dark Vaporeon from Pokemon Team Rocket expansion. Card #45, Lightly Played condition. Fast shipping from CardMint.'
FROM p;
WITH p AS (SELECT product_id FROM product WHERE sku = 'PKM-TEAMROCKET-45-LP')
INSERT INTO product_image (product_image_product_id, origin_image, is_main)
SELECT p.product_id, 'https://ik.imagekit.io/p9d2ahrjq/products/cb6e6748-6a3d-4258-b4e1-db8b96f33b83.jpg', true
FROM p;
WITH p AS (SELECT product_id FROM product WHERE sku = 'PKM-TEAMROCKET-45-LP')
INSERT INTO product_inventory (product_inventory_product_id, qty, manage_stock, stock_availability)
SELECT p.product_id, 1, true, true
FROM p;

-- 2. Pikachu - Base Set #25 (qty 6)
INSERT INTO product (sku, price, weight, status, visibility)
VALUES ('PKM-BASE-25-NM', 12.00, 0.01, true, true);
WITH p AS (SELECT product_id FROM product WHERE sku = 'PKM-BASE-25-NM')
INSERT INTO product_description (product_description_product_id, name, description, url_key, meta_title, meta_description)
SELECT p.product_id,
       'Pikachu',
       'Pikachu from Base Set (#25). Condition: NM (Near Mint). The iconic original Pikachu from the very first Pokemon TCG set.',
       'pikachu-base-set-25',
       'Pikachu - Base Set #25 | CardMint',
       'Buy Pikachu from the original Base Set expansion. Card #25, Near Mint condition. The iconic starter Pokemon card.'
FROM p;
WITH p AS (SELECT product_id FROM product WHERE sku = 'PKM-BASE-25-NM')
INSERT INTO product_image (product_image_product_id, origin_image, is_main)
SELECT p.product_id, 'https://ik.imagekit.io/p9d2ahrjq/products/058f0629-3443-4c9e-a34b-63a856a5789e.jpg', true
FROM p;
WITH p AS (SELECT product_id FROM product WHERE sku = 'PKM-BASE-25-NM')
INSERT INTO product_inventory (product_inventory_product_id, qty, manage_stock, stock_availability)
SELECT p.product_id, 6, true, true
FROM p;

-- 3. Pikachu - Pokemon Evolutions #35
INSERT INTO product (sku, price, weight, status, visibility)
VALUES ('PKM-EVO-35-NM', 3.50, 0.01, true, true);
WITH p AS (SELECT product_id FROM product WHERE sku = 'PKM-EVO-35-NM')
INSERT INTO product_description (product_description_product_id, name, description, url_key, meta_title, meta_description)
SELECT p.product_id,
       'Pikachu',
       'Pikachu from Pokemon Evolutions (#35). Condition: NM (Near Mint). A modern reprint paying homage to the original Base Set artwork.',
       'pikachu-evolutions-35',
       'Pikachu - Pokemon Evolutions #35 | CardMint',
       'Buy Pikachu from Pokemon Evolutions. Card #35, Near Mint condition. Modern reprint of the classic Base Set design.'
FROM p;
WITH p AS (SELECT product_id FROM product WHERE sku = 'PKM-EVO-35-NM')
INSERT INTO product_image (product_image_product_id, origin_image, is_main)
SELECT p.product_id, 'https://ik.imagekit.io/p9d2ahrjq/products/b605d393-52c4-4c15-b749-302be77596ab.jpg', true
FROM p;
WITH p AS (SELECT product_id FROM product WHERE sku = 'PKM-EVO-35-NM')
INSERT INTO product_inventory (product_inventory_product_id, qty, manage_stock, stock_availability)
SELECT p.product_id, 1, true, true
FROM p;

-- 4. Piplup - Pokemon BREAKthrough #36
INSERT INTO product (sku, price, weight, status, visibility)
VALUES ('PKM-BKT-36-NM', 0.50, 0.01, true, true);
WITH p AS (SELECT product_id FROM product WHERE sku = 'PKM-BKT-36-NM')
INSERT INTO product_description (product_description_product_id, name, description, url_key, meta_title, meta_description)
SELECT p.product_id,
       'Piplup',
       'Piplup from Pokemon BREAKthrough (#36). Condition: NM (Near Mint). The adorable Water-type starter from Generation IV.',
       'piplup-breakthrough-36',
       'Piplup - Pokemon BREAKthrough #36 | CardMint',
       'Buy Piplup from Pokemon BREAKthrough. Card #36, Near Mint condition. Cute Water-type starter Pokemon card.'
FROM p;
WITH p AS (SELECT product_id FROM product WHERE sku = 'PKM-BKT-36-NM')
INSERT INTO product_image (product_image_product_id, origin_image, is_main)
SELECT p.product_id, 'https://ik.imagekit.io/p9d2ahrjq/products/1f58f579-42a2-4363-bf8b-1f1f2d73fe58.jpg', true
FROM p;
WITH p AS (SELECT product_id FROM product WHERE sku = 'PKM-BKT-36-NM')
INSERT INTO product_inventory (product_inventory_product_id, qty, manage_stock, stock_availability)
SELECT p.product_id, 1, true, true
FROM p;

-- 5. Raikou - Pokemon Shining Legends #32 (Reverse Holo)
INSERT INTO product (sku, price, weight, status, visibility)
VALUES ('PKM-SLG-32-RH-NM', 2.00, 0.01, true, true);
WITH p AS (SELECT product_id FROM product WHERE sku = 'PKM-SLG-32-RH-NM')
INSERT INTO product_description (product_description_product_id, name, description, url_key, meta_title, meta_description)
SELECT p.product_id,
       'Raikou (Reverse Holo)',
       'Raikou from Pokemon Shining Legends (#32). Condition: NM (Near Mint). Reverse Holo variant of this legendary Electric-type Pokemon.',
       'raikou-shining-legends-32-reverse-holo',
       'Raikou Reverse Holo - Pokemon Shining Legends #32 | CardMint',
       'Buy Raikou Reverse Holo from Pokemon Shining Legends. Card #32, Near Mint condition. Legendary Electric-type Pokemon card.'
FROM p;
WITH p AS (SELECT product_id FROM product WHERE sku = 'PKM-SLG-32-RH-NM')
INSERT INTO product_image (product_image_product_id, origin_image, is_main)
SELECT p.product_id, 'https://ik.imagekit.io/p9d2ahrjq/products/6fd478ab-d4a1-4f85-a20c-a29231a64263.jpg', true
FROM p;
WITH p AS (SELECT product_id FROM product WHERE sku = 'PKM-SLG-32-RH-NM')
INSERT INTO product_inventory (product_inventory_product_id, qty, manage_stock, stock_availability)
SELECT p.product_id, 1, true, true
FROM p;

-- 6. Rattata - Base Set #61
INSERT INTO product (sku, price, weight, status, visibility)
VALUES ('PKM-BASE-61-NM', 0.25, 0.01, true, true);
WITH p AS (SELECT product_id FROM product WHERE sku = 'PKM-BASE-61-NM')
INSERT INTO product_description (product_description_product_id, name, description, url_key, meta_title, meta_description)
SELECT p.product_id,
       'Rattata',
       'Rattata from Base Set (#61). Condition: NM (Near Mint). Classic common card from the original Pokemon TCG set.',
       'rattata-base-set-61',
       'Rattata - Base Set #61 | CardMint',
       'Buy Rattata from the original Base Set. Card #61, Near Mint condition. Classic common Pokemon card.'
FROM p;
WITH p AS (SELECT product_id FROM product WHERE sku = 'PKM-BASE-61-NM')
INSERT INTO product_image (product_image_product_id, origin_image, is_main)
SELECT p.product_id, 'https://ik.imagekit.io/p9d2ahrjq/products/4cd44c5d-a071-4a84-9db4-0dce819cbad5.jpg', true
FROM p;
WITH p AS (SELECT product_id FROM product WHERE sku = 'PKM-BASE-61-NM')
INSERT INTO product_inventory (product_inventory_product_id, qty, manage_stock, stock_availability)
SELECT p.product_id, 5, true, true
FROM p;

-- 7. Rayquaza - Pokemon Guardians Rising #106
INSERT INTO product (sku, price, weight, status, visibility)
VALUES ('PKM-GRI-106-NM', 1.00, 0.01, true, true);
WITH p AS (SELECT product_id FROM product WHERE sku = 'PKM-GRI-106-NM')
INSERT INTO product_description (product_description_product_id, name, description, url_key, meta_title, meta_description)
SELECT p.product_id,
       'Rayquaza',
       'Rayquaza from Pokemon Guardians Rising (#106). Condition: NM (Near Mint). The powerful Dragon/Flying legendary Pokemon.',
       'rayquaza-guardians-rising-106',
       'Rayquaza - Pokemon Guardians Rising #106 | CardMint',
       'Buy Rayquaza from Pokemon Guardians Rising. Card #106, Near Mint condition. Legendary Dragon-type Pokemon card.'
FROM p;
WITH p AS (SELECT product_id FROM product WHERE sku = 'PKM-GRI-106-NM')
INSERT INTO product_image (product_image_product_id, origin_image, is_main)
SELECT p.product_id, 'https://ik.imagekit.io/p9d2ahrjq/products/24b386aa-c737-4e22-abd9-ce91a1a517ca.jpg', true
FROM p;
WITH p AS (SELECT product_id FROM product WHERE sku = 'PKM-GRI-106-NM')
INSERT INTO product_inventory (product_inventory_product_id, qty, manage_stock, stock_availability)
SELECT p.product_id, 1, true, true
FROM p;

-- Fix image URLs (EverShop trigger mangles external URLs by prepending /assets)
UPDATE product_image
SET
  thumb_image = origin_image,
  listing_image = origin_image,
  single_image = origin_image
WHERE origin_image LIKE 'https://%';

COMMIT;

-- Verification
SELECT 'Products inserted:' as status, COUNT(*) as count FROM product;
SELECT p.sku, pd.name, pi.qty, pg.origin_image
FROM product p
JOIN product_description pd ON p.product_id = pd.product_description_product_id
JOIN product_inventory pi ON p.product_id = pi.product_inventory_product_id
LEFT JOIN product_image pg ON p.product_id = pg.product_image_product_id
ORDER BY pd.name;
