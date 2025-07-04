require('dotenv').config();
const { chromium } = require('playwright');
const readline = require('readline');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const franc = require('franc');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY not found in .env file.');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Add at the top of the file
const BLOCKED_DOMAINS = ['forbes.com', 'bloomberg.com', 'businessinsider.com'];
function isBlockedDomain(url) {
  return BLOCKED_DOMAINS.some(domain => url.includes(domain));
}

// Helper: Get user input from CLI
function getUserQuery() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question('Enter your research query: ', (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// Helper: Extract organic Bing search result titles and URLs
async function getTopBingResults(query, numResults = 5) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://www.bing.com', { timeout: 60000 });
  await page.waitForTimeout(2000);
  let input = await page.$('input[name="q"]') || await page.$('input[type="search"]') || await page.$('input[type="text"]');
  if (input) {
    await input.focus();
    await page.waitForTimeout(500);
    await input.type(query, { delay: 100 });
    await page.waitForTimeout(500);
  } else {
    await browser.close();
    throw new Error('Could not find Bing search input.');
  }
  await page.keyboard.press('Enter');
  await page.waitForSelector('li.b_algo h2 a', { timeout: 60000 });
  const results = await page.$$eval('li.b_algo h2 a', (elements) => {
    return elements.map(el => {
      let href = el.href;
      // If Bing redirect, try to extract the real URL
      const urlMatch = href.match(/https?:\/\/[^&]+/);
      if (urlMatch) {
        href = decodeURIComponent(urlMatch[0]);
      }
      return {
        title: el.innerText.trim(),
        url: href
      };
    }).filter(r => r.url && r.title);
  });
  await browser.close();
  return results.slice(0, numResults);
}

// Helper: Special extraction for known sites
async function specialExtract(url, page) {
  if (url.includes('github.com')) {
    // Try to extract README or main content
    try {
      await page.waitForSelector('article.markdown-body', { timeout: 5000 });
      return await page.$eval('article.markdown-body', el => el.innerText);
    } catch {}
    try {
      await page.waitForSelector('div#readme', { timeout: 5000 });
      return await page.$eval('div#readme', el => el.innerText);
    } catch {}
  }
  if (url.includes('stackoverflow.com')) {
    // Extract main question and top answer
    try {
      await page.waitForSelector('.question .js-post-body', { timeout: 5000 });
      const question = await page.$eval('.question .js-post-body', el => el.innerText);
      let answer = '';
      try {
        await page.waitForSelector('.answer .js-post-body', { timeout: 5000 });
        answer = await page.$eval('.answer .js-post-body', el => el.innerText);
      } catch {}
      return question + (answer ? '\n\nTop Answer:\n' + answer : '');
    } catch {}
  }
  if (url.includes('docs.n8n.io')) {
    // Extract main doc section
    try {
      await page.waitForSelector('main', { timeout: 5000 });
      return await page.$eval('main', el => el.innerText);
    } catch {}
  }
  return null;
}

// Helper: Extract main content from a page (with special extraction)
async function extractMainContent(url) {
  if (url.toLowerCase().endsWith('.pdf')) {
    console.log(`Skipping PDF: ${url}`);
    return '';
  }
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(url, { timeout: 30000 });
    await page.waitForTimeout(2000);
    let content = await page.evaluate(() => {
      function getLargestTextBlock() {
        let candidates = Array.from(document.querySelectorAll('article, main, div'));
        candidates = candidates.filter(el => el.innerText && el.innerText.length > 200);
        candidates.sort((a, b) => b.innerText.length - a.innerText.length);
        return candidates.length ? candidates[0].innerText : document.body.innerText;
      }
      return getLargestTextBlock();
    });
    if (!content || content.length < 200) {
      // Try Readability
      const html = await page.content();
      const dom = new JSDOM(html, { url });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();
      content = article ? article.textContent : '';
    }
    return content ? content.slice(0, 4000) : '';
  } catch (e) {
    console.error(`Failed to extract content from ${url}:`, e.message);
    return '';
  } finally {
    await browser.close();
  }
}

// Helper: Check for generic titles
function isGenericTitle(title) {
  const generic = ['home', 'welcome', 'category', 'index', 'main page'];
  return generic.some(g => title.toLowerCase().includes(g));
}

// Helper: Extract domain from URL
function getDomain(url) {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return '';
  }
}

// Helper: Rate relevance using Gemini
async function rateRelevanceWithGemini(query, content) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const prompt = `You are an expert research assistant. Given the following research query and an article, rate the article's relevance to the query on a scale of 1 (not relevant) to 10 (highly relevant). Only output the number.\n\nQuery: ${query}\n\nArticle:\n${content}`;
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const score = parseInt(text.match(/\d+/)?.[0] || '0', 10);
    return isNaN(score) ? 0 : score;
  } catch (e) {
    console.error('Gemini API error (relevance):', e.message);
    return 0;
  }
}

// Helper: Remove all keyword-like lists from summary
function removeKeywordSections(summary) {
  // Remove '**Top 5 Keywords:**' and any following list (bullets, numbers, or lines until a blank or divider)
  return summary.replace(/\*\*Top 5 Keywords:?\*\*[\s\S]*?(?:\n\s*\n|\n---|$)/gi, '')
    .replace(/(\n|^)Keywords:\s*[\s\S]*?(?:\n\s*\n|\n---|$)/gi, '')
    .replace(/(\n|^)\d+\.\s.*?(?:\n|$)/g, '') // Remove numbered lists
    .replace(/(\n|^)[*-]\s.*?(?:\n|$)/g, ''); // Remove bullet lists
}

// Helper: Convert Medium URLs to Freedium URLs
function toFreediumUrl(url) {
  if (url.includes('medium.com')) {
    return url.replace('medium.com', 'freedium.cfd');
  }
  return url;
}

// Add slugify helper at the top
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 40);
}

// Main workflow
(async () => {
  const query = await getUserQuery();
  console.log(`\nSearching Bing for: ${query}\n`);
  const results = await getTopBingResults(query, 7);
  if (!results.length) {
    console.log('No results found.');
    return;
  }
  // Display all URLs and titles
  console.log('\nExtracted URLs:');
  results.forEach((r, i) => {
    console.log(`\n[${i + 1}] ${r.title}\n    ${r.url}`);
  });
  // Wait for user confirmation before summarizing
  await new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question('\nPress Enter to start summarization...', () => {
      rl.close();
      resolve();
    });
  });
  // Now proceed to summarization
  const rawExtracted = [];
  for (let i = 0; i < results.length; i++) {
    const { title, url } = results[i];
    if (isBlockedDomain(url)) {
      console.log(`[${i + 1}] Skipped (blocked domain): ${title}\n    ${url}`);
      continue;
    }
    console.log(`\n[${i + 1}] ${title}\n    ${url}`);
    let content = await extractMainContent(url);
    if (content) {
      content = content.replace(/\n+/g, ' ').trim();
      console.log(`[${i + 1}] Content snippet:`, content.slice(0, 200));
    } else {
      console.log(`[${i + 1}] Content is empty.`);
    }
    rawExtracted.push({
      number: i + 1,
      title,
      url,
      content
    });
    if (!content || content.length < 200) {
      console.log('Could not extract sufficient content.');
      continue;
    }
    console.log('Summarizing...');
    const summary = await summarizeWithGemini(content);
    console.log(summary);
  }
  // After the loop, save rawExtracted to JSON
  const now = new Date();
  const isoDate = now.toISOString().slice(0, 10);
  const reportDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir);
  const slug = slugify(query);
  const rawJsonPath = path.join(reportDir, `raw_extracted_results_${slug}_${isoDate}.json`);
  fs.writeFileSync(rawJsonPath, JSON.stringify(rawExtracted, null, 2), 'utf-8');
  console.log('Raw extracted data saved to', rawJsonPath);

  // After summarization, build a professional Markdown report in /reports
  const timestamp = now.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  let markdown = `# Research Results for: ${query}\n\n*Report generated: ${timestamp}*\n\n`;
  // Table of Contents
  markdown += '## Table of Contents\n';
  results.forEach((r, i) => {
    const anchor = r.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    markdown += `${i + 1}. [${r.title}](#${anchor})\n`;
  });
  markdown += '\n---\n\n';
  // Summaries
  for (let i = 0; i < results.length; i++) {
    const { title, url } = results[i];
    if (isBlockedDomain(url)) continue;
    let content = await extractMainContent(url);
    if (!content || content.length < 200) continue;
    const summary = await summarizeWithGemini(content);
    const anchor = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    markdown += `## [${i + 1}] ${title}\n**URL:** [${url}](${url})\n\n**Domain:** ${getDomain(url)}\n\n**Summary:**\n${summary}\n\n---\n\n`;
  }
  // Sources section
  markdown += '## Sources\n';
  results.forEach((r, i) => {
    if (!isBlockedDomain(r.url)) markdown += `${i + 1}. ${r.url}\n`;
  });
  markdown += '\n---\n*Generated by Researcher Agent v1.0*\n';
  const reportPath = path.join(reportDir, `report_${slug}_${isoDate}.md`);
  fs.writeFileSync(reportPath, markdown, 'utf-8');
  console.log('Results saved to', reportPath);
})();

// Update Gemini prompt for 130-150 word summary
async function summarizeWithGemini(text) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const prompt = `Summarize the following article in 130 to 150 words in clear, professional language. Focus on the main findings and actionable insights. At the end, list the top 5 keywords that capture the essence of the article.\n\nArticle:\n${text}`;
    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (e) {
    console.error('Gemini API error:', e.message);
    return 'Summary unavailable.';
  }
} 