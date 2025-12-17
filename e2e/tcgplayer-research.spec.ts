import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * TCGPlayer Competitive Research - Pokemon Browsing Experience
 *
 * This test systematically documents TCGPlayer's product browsing interface
 * to inform CardMint's product development strategy.
 */

const RESEARCH_OUTPUT_DIR = path.join(__dirname, '../research/tcgplayer-analysis');

test.describe('TCGPlayer Pokemon Browsing Research', () => {
  test.beforeAll(() => {
    // Ensure output directory exists
    if (!fs.existsSync(RESEARCH_OUTPUT_DIR)) {
      fs.mkdirSync(RESEARCH_OUTPUT_DIR, { recursive: true });
    }
  });

  test('Document complete browsing experience', async ({ page }) => {
    const findings: any = {
      timestamp: new Date().toISOString(),
      url: 'https://www.tcgplayer.com/search/pokemon/product?productLineName=pokemon&page=1&view=grid',
      filters: {},
      sortOptions: [],
      viewModes: [],
      cardDisplayInfo: [],
      pagination: {},
      screenshots: [],
      notes: []
    };

    // Set viewport to desktop size
    await page.setViewportSize({ width: 1920, height: 1080 });

    console.log('🔍 Navigating to TCGPlayer Pokemon search...');
    await page.goto('https://www.tcgplayer.com/search/pokemon/product?productLineName=pokemon&page=1&view=grid', {
      waitUntil: 'networkidle',
      timeout: 30000
    });

    // Wait for page to fully load
    await page.waitForTimeout(3000);

    // Take initial screenshot
    console.log('📸 Capturing initial page state...');
    await page.screenshot({
      path: path.join(RESEARCH_OUTPUT_DIR, '01-initial-page.png'),
      fullPage: true
    });
    findings.screenshots.push('01-initial-page.png');

    // PHASE 1: Document Page Structure
    console.log('\n📋 PHASE 1: Analyzing page structure...');

    const pageTitle = await page.title();
    findings.pageTitle = pageTitle;
    console.log(`Page Title: ${pageTitle}`);

    // Check for main content areas
    const hasLeftSidebar = await page.locator('[class*="sidebar"], [class*="filter"]').first().isVisible().catch(() => false);
    const hasResultsArea = await page.locator('[class*="results"], [class*="product"], [class*="card"]').first().isVisible().catch(() => false);

    findings.layout = {
      hasLeftSidebar,
      hasResultsArea
    };

    // PHASE 2: Document Filter System
    console.log('\n🔍 PHASE 2: Documenting filter system...');

    // Try multiple selectors to find filters
    const filterSelectors = [
      '[class*="filter"]',
      '[class*="facet"]',
      'aside',
      '[role="complementary"]',
      '.sidebar'
    ];

    for (const selector of filterSelectors) {
      const filterContainer = page.locator(selector).first();
      if (await filterContainer.isVisible().catch(() => false)) {
        console.log(`Found filter container with selector: ${selector}`);

        // Take screenshot of filters
        await page.screenshot({
          path: path.join(RESEARCH_OUTPUT_DIR, '02-filters-overview.png'),
          fullPage: true
        });
        findings.screenshots.push('02-filters-overview.png');

        // Document all filter categories
        const filterGroups = await filterContainer.locator('[class*="group"], [class*="section"], fieldset').all();
        console.log(`Found ${filterGroups.length} filter groups`);

        for (let i = 0; i < filterGroups.length; i++) {
          const group = filterGroups[i];
          const groupText = await group.textContent().catch(() => '');
          console.log(`Filter Group ${i + 1}: ${groupText.substring(0, 100)}...`);
        }

        break;
      }
    }

    // Try to find specific filter types
    const filterTypes = [
      { name: 'Set', selectors: ['[data-testid*="set"]', 'button:has-text("Set")', 'div:has-text("Set")'] },
      { name: 'Card Type', selectors: ['[data-testid*="type"]', 'button:has-text("Card Type")', 'div:has-text("Card Type")'] },
      { name: 'Rarity', selectors: ['[data-testid*="rarity"]', 'button:has-text("Rarity")', 'div:has-text("Rarity")'] },
      { name: 'Condition', selectors: ['[data-testid*="condition"]', 'button:has-text("Condition")', 'div:has-text("Condition")'] },
      { name: 'Price', selectors: ['[data-testid*="price"]', 'button:has-text("Price")', 'div:has-text("Price")'] }
    ];

    for (const filterType of filterTypes) {
      for (const selector of filterType.selectors) {
        const element = page.locator(selector).first();
        if (await element.isVisible().catch(() => false)) {
          console.log(`✓ Found ${filterType.name} filter`);
          findings.filters[filterType.name] = { found: true, selector };

          // Try to expand if it's a button
          if (selector.includes('button')) {
            await element.click().catch(() => {});
            await page.waitForTimeout(500);
          }
          break;
        }
      }
    }

    // PHASE 3: Document Sort Options
    console.log('\n⬇️ PHASE 3: Documenting sort options...');

    const sortSelectors = [
      '[data-testid*="sort"]',
      'select:has-text("Sort")',
      'button:has-text("Sort")',
      '[class*="sort"]'
    ];

    for (const selector of sortSelectors) {
      const sortElement = page.locator(selector).first();
      if (await sortElement.isVisible().catch(() => false)) {
        console.log(`Found sort control with selector: ${selector}`);

        // Click to reveal options
        await sortElement.click().catch(() => {});
        await page.waitForTimeout(500);

        await page.screenshot({
          path: path.join(RESEARCH_OUTPUT_DIR, '03-sort-options.png')
        });
        findings.screenshots.push('03-sort-options.png');

        // Get options
        const options = await page.locator('option, [role="option"], [role="menuitem"]').allTextContents();
        findings.sortOptions = options.filter(o => o.trim().length > 0);
        console.log(`Sort options: ${findings.sortOptions.join(', ')}`);

        // Close dropdown
        await page.keyboard.press('Escape');
        break;
      }
    }

    // PHASE 4: Check View Toggle
    console.log('\n👁️ PHASE 4: Checking view toggle options...');

    const viewToggleSelectors = [
      '[data-testid*="view"]',
      'button[aria-label*="grid"]',
      'button[aria-label*="list"]',
      '[class*="view-toggle"]'
    ];

    for (const selector of viewToggleSelectors) {
      const viewElement = page.locator(selector).first();
      if (await viewElement.isVisible().catch(() => false)) {
        console.log(`Found view toggle with selector: ${selector}`);
        findings.viewModes.push('grid', 'list');
        break;
      }
    }

    // PHASE 5: Document Card Display Information
    console.log('\n🃏 PHASE 5: Analyzing card display information...');

    const cardSelectors = [
      '[data-testid*="product"]',
      '[class*="product-card"]',
      '[class*="search-result"]',
      'article',
      '.card'
    ];

    for (const selector of cardSelectors) {
      const cards = page.locator(selector);
      const count = await cards.count();

      if (count > 0) {
        console.log(`Found ${count} cards with selector: ${selector}`);

        // Analyze first card
        const firstCard = cards.first();
        await firstCard.scrollIntoViewIfNeeded().catch(() => {});

        // Take screenshot of first card
        await firstCard.screenshot({
          path: path.join(RESEARCH_OUTPUT_DIR, '04-card-detail.png')
        }).catch(() => {});
        findings.screenshots.push('04-card-detail.png');

        const cardInfo = {
          hasImage: await firstCard.locator('img').isVisible().catch(() => false),
          hasTitle: await firstCard.locator('[class*="name"], [class*="title"], h2, h3').isVisible().catch(() => false),
          hasPrice: await firstCard.locator('[class*="price"]').isVisible().catch(() => false),
          hasSet: await firstCard.locator('[class*="set"]').isVisible().catch(() => false),
          hasRarity: await firstCard.locator('[class*="rarity"]').isVisible().catch(() => false),
          textContent: await firstCard.textContent().then(t => t?.substring(0, 200))
        };

        findings.cardDisplayInfo.push(cardInfo);
        console.log('Card info structure:', cardInfo);
        break;
      }
    }

    // PHASE 6: Document Pagination
    console.log('\n📄 PHASE 6: Analyzing pagination...');

    const paginationSelectors = [
      '[class*="pagination"]',
      'nav[aria-label*="pagination"]',
      '[role="navigation"]'
    ];

    for (const selector of paginationSelectors) {
      const pagination = page.locator(selector).first();
      if (await pagination.isVisible().catch(() => false)) {
        console.log(`Found pagination with selector: ${selector}`);

        await pagination.screenshot({
          path: path.join(RESEARCH_OUTPUT_DIR, '05-pagination.png')
        }).catch(() => {});
        findings.screenshots.push('05-pagination.png');

        const paginationText = await pagination.textContent();
        findings.pagination = {
          found: true,
          text: paginationText?.substring(0, 200)
        };
        console.log(`Pagination info: ${paginationText?.substring(0, 100)}`);
        break;
      }
    }

    // PHASE 7: Document Full Page
    console.log('\n📸 PHASE 7: Final full page screenshot...');
    await page.screenshot({
      path: path.join(RESEARCH_OUTPUT_DIR, '06-full-page-final.png'),
      fullPage: true
    });
    findings.screenshots.push('06-full-page-final.png');

    // Save findings as JSON
    const jsonPath = path.join(RESEARCH_OUTPUT_DIR, 'findings.json');
    fs.writeFileSync(jsonPath, JSON.stringify(findings, null, 2));
    console.log(`\n✅ Research complete! Findings saved to: ${jsonPath}`);

    // Generate HTML snapshot
    const htmlContent = await page.content();
    const htmlPath = path.join(RESEARCH_OUTPUT_DIR, 'page-snapshot.html');
    fs.writeFileSync(htmlPath, htmlContent);
    console.log(`📄 HTML snapshot saved to: ${htmlPath}`);

    // Summary
    console.log('\n=== RESEARCH SUMMARY ===');
    console.log(`Filters found: ${Object.keys(findings.filters).length}`);
    console.log(`Sort options: ${findings.sortOptions.length}`);
    console.log(`View modes: ${findings.viewModes.length}`);
    console.log(`Screenshots: ${findings.screenshots.length}`);
    console.log(`Output directory: ${RESEARCH_OUTPUT_DIR}`);
  });
});
