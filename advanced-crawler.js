// advanced-crawler.js - Versione per applicazioni moderne (React, Vue, Angular, HTML5)
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';
import { URL } from 'url';

// Disable stealth plugin again for minimal launch test
// puppeteer.use(StealthPlugin());

const visited = new Set();
const linksFound = new Set();
const formsFound = new Set();
const endpointsFound = new Set();
const reactComponentsFound = new Set();
const jsFrameworksDetected = new Set();
const requestsToReplicate = [];

const MAX_DEPTH = 3;
const WAIT_TIME = 5000; // Tempo di attesa più lungo per applicazioni SPA
const MAX_CONCURRENT_PAGES = 5; // Max number of pages to crawl concurrently

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setupPage(page) {
  // Imposta user agent
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36'
  );

  // Imposta header HTTP
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9,it;q=0.8',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1'
  });

  // Abilita eventi di console
  page.on('console', msg => {
    const type = msg.type().substr(0, 3).toUpperCase();
    const text = msg.text();
    if (text.includes('Failed to load resource: the server responded with a status of 404 ()') && text.includes('favicon.ico')) {
        return;
    }
    // Log solo errori e warning per ridurre verbosità, ma includi URL della pagina per contesto
    const pageUrlForLog = page.url(); // Get current page URL for logging context
    if (type === 'ERR') {
      console.log(`🔴 (${new URL(pageUrlForLog).pathname}) Console Error: ${text}`);
    } else if (type === 'WAR') {
      console.log(`🟠 (${new URL(pageUrlForLog).pathname}) Console Warning: ${text}`);
    }
  });

  // Gestione dialoghi
  page.on('dialog', async dialog => {
    console.log(`ℹ️ Dialogo [${dialog.type()}] su ${page.url()}: "${dialog.message()}". Accettazione.`);
    try {
        await dialog.accept();
    } catch (e) {
        // console.warn(`Impossibile accettare il dialogo: ${e.message}`);
    }
  });
}

// Funzione per rilevare framework JavaScript
async function detectFrameworks(page) {
  return page.evaluate(() => {
    const frameworks = [];
    
    // Rileva React
    if (window.React || document.querySelector('[data-reactroot], [data-reactid]') || 
        Array.from(document.querySelectorAll('*')).some(el => Object.keys(el).some(key => key.startsWith('__react')))) {
      frameworks.push('React');
    }
    
    // Rileva Vue
    if (window.Vue || document.querySelector('[data-v-]') || document.querySelector('div[id="app"][data-server-rendered]')) {
      frameworks.push('Vue.js');
    }
    
    // Rileva Angular
    if (window.angular || document.querySelector('[ng-app], [data-ng-app], [ng-controller], [data-ng-controller], [ng-repeat], [data-ng-repeat]') ||
        document.querySelector('app-root') || document.querySelector('[ng-version]')) {
      frameworks.push('Angular');
    }
    
    // Rileva jQuery
    if (window.jQuery || window.$) {
      frameworks.push('jQuery');
    }
    
    // Rileva Bootstrap
    if (document.querySelector('.container, .row, .col, .btn-primary, .navbar-nav')) {
      frameworks.push('Bootstrap');
    }
    
    return frameworks;
  });
}

// Funzione per estrarre componenti React
async function extractReactComponents(page) {
  return page.evaluate(() => {
    const reactComponents = new Set();
    
    // Cerca componenti React basati su convenzioni di naming
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      // Cerca elementi che potrebbero essere componenti React (PascalCase o con props di React)
      if (el.tagName && el.tagName.includes('-')) {
        reactComponents.add(el.tagName.toLowerCase());
      }
      
      // Cerca attributi che potrebbero indicare componenti React
      for (const attr of el.attributes) {
        if (attr.name.startsWith('data-react-') || 
            attr.name === 'data-reactroot' || 
            attr.name.startsWith('data-testid')) {
          reactComponents.add(el.tagName.toLowerCase() + '[' + attr.name + ']');
        }
      }
    }
    
    return Array.from(reactComponents);
  });
}

async function extractInfo(url, page) {
  const base = new URL(url);
  const pageData = {
    links: new Set(),
    forms: new Set(),
    endpoints: new Set(),
    reactComponents: new Set(),
    jsFrameworks: new Set(),
    requestsToReplicateForPage: []
  };

  try {
    // Simplify request interception for debugging ERR_BLOCKED_BY_CLIENT
    if (!page._requestInterceptionEnabled) {
      page._requestInterceptionEnabled = true; 
      await page.setRequestInterception(true);
      page.on('request', request => {
        // Temporarily simplified to only continue requests
        if (!request.isInterceptResolutionHandled()) {
          request.continue();
        }
        // Original logic commented out for debugging:
        /*
        const requestData = { url: request.url(), method: request.method(), headers: request.headers(), postData: request.postData(), resourceType: request.resourceType() };
        if (request.method() !== 'GET') { pageData.requestsToReplicateForPage.push(requestData); }
        if (request.resourceType() === 'xhr' || request.resourceType() === 'fetch' || request.url().includes('/api/') || request.url().includes('/graphql')) {
          pageData.endpoints.add(`[INTERCEPTED] ${request.method()} ${request.url()}`);
        }
        if (!request.isInterceptResolutionHandled()) {
            request.continue();
        }
        */
      });
    }

    console.log(`🔄 Navigando (extractInfo) a: ${url} (Timeout: 90s, WaitUntil: domcontentloaded)`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    console.log(`✅ Navigazione completata per: ${url}. Ora imposto permessi.`);

    try {
      const context = page.browser().defaultBrowserContext();
      await context.overridePermissions(url, [
        'geolocation',
        'notifications',
        'clipboard-read',
        'clipboard-write',
        'microphone',
        'camera'
      ]);
      console.log(`🔑 Permessi impostati per: ${url}`);
    } catch (permError) {
      console.warn(`⚠️ Impossibile impostare i permessi per ${url}: ${permError.message.split('\n')[0]}`);
    }

    console.log(`⏳ Attesa post-navigazione/permessi (extractInfo): ${url}`);
    await sleep(WAIT_TIME);

    await page.evaluate(async () => {
      await new Promise(resolve => {
        let totalHeight = 0; const distance = 100; const timer = setInterval(() => {
          const scrollHeight = document.body.scrollHeight; window.scrollBy(0, distance); totalHeight += distance;
          if (totalHeight >= scrollHeight) { clearInterval(timer); resolve(); }
        }, 100);
      });
    });
    
    const detectedFrameworksArray = await detectFrameworks(page);
    if (detectedFrameworksArray.length > 0) {
      console.log(`🔍 Frameworks su ${url}: ${detectedFrameworksArray.join(', ')}`);
      detectedFrameworksArray.forEach(fw => pageData.jsFrameworks.add(fw));
    }
    
    if (detectedFrameworksArray.includes('React')) {
      const reactComponentsArray = await extractReactComponents(page);
      if (reactComponentsArray.length > 0) {
        console.log(`⚛️ ${reactComponentsArray.length} React components su ${url}`);
        reactComponentsArray.forEach(comp => pageData.reactComponents.add(comp));
      }
    }

    const content = await page.content();
    const $ = cheerio.load(content);

    // Estrazione link
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      
      try {
        let fullUrl;
        if (href.startsWith('#')) {
          fullUrl = `${url}${href}`;
        } else if (href.startsWith('javascript:')) {
          return;
        } else {
          fullUrl = new URL(href, base).toString();
        }
        
        fullUrl = fullUrl.split('#')[0];
        
        if (fullUrl.startsWith(base.origin)) {
          pageData.links.add(fullUrl);
        }
      } catch (e) {
        // Ignora URL malformati
      }
    });

    // Estrazione form
    $('form').each((_, form) => {
      const action = $(form).attr('action') || url;
      const method = ($(form).attr('method') || 'GET').toUpperCase();
      const formId = $(form).attr('id') || '';
      const formClass = $(form).attr('class') || '';
      const formName = $(form).attr('name') || '';
      const formData = [];
      
      $(form).find('input, textarea, select, button').each((_, input) => {
        const inputData = {
          name: $(input).attr('name') || '',
          type: $(input).attr('type') || $(input).prop('tagName').toLowerCase(),
          id: $(input).attr('id') || '',
          value: $(input).attr('value') || '',
          required: $(input).attr('required') !== undefined,
          placeholder: $(input).attr('placeholder') || ''
        };
        formData.push(inputData);
      });
      
      const formDetails = {
        url,
        action: action.startsWith('http') ? action : new URL(action, base).toString(),
        method,
        id: formId,
        name: formName,
        class: formClass,
        fields: formData
      };
      pageData.forms.add(JSON.stringify(formDetails));
    });

    // Estrazione di API endpoints da script inline
    $('script:not([src])').each((_, script) => {
      const scriptContent = $(script).html();
      if (!scriptContent) return;
      
      const patterns = [
        /fetch\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*\{[^}]*method\s*:\s*['"]([^'"]+)['"][^}]*\})?/gi,
        /axios\.(get|post|put|delete|patch|options|head)\s*\(\s*['"]([^'"]+)['"]/gi,
        /\$\.(ajax|get|post)\s*\(\s*(?:['"]([^'"]+)['"]|{[^}]*url\s*:\s*['"]([^'"]+)['"][^}]*})/gi,
        /url\s*:\s*['"]([^'"]+)['"]/gi,
        /['"]?(?:endpoint|api(?:Path|Url)?|url)['"]?\s*:\s*['"]([^'"]+)['"]/gi,
        /\/api\/[\w\/-]+/g,
        /\/graphql/g,
        /\/v\d+\/[\w\/-]+/g
      ];
      
      patterns.forEach((pattern, patternIndex) => {
        let matchInstance;
        while ((matchInstance = pattern.exec(scriptContent)) !== null) {
          let extractedUrlString = null;
          let inferredMethod = null;

          if (patternIndex === 0) { extractedUrlString = matchInstance[1]; if (matchInstance[2]) inferredMethod = matchInstance[2].toUpperCase(); }
          else if (patternIndex === 1) { inferredMethod = matchInstance[1].toUpperCase(); extractedUrlString = matchInstance[2]; }
          else if (patternIndex === 2) { if (matchInstance[1].toLowerCase() === 'get' || matchInstance[1].toLowerCase() === 'post') { inferredMethod = matchInstance[1].toUpperCase(); } extractedUrlString = matchInstance[2] || matchInstance[3]; }
          else if (patternIndex === 3 || patternIndex === 4) { extractedUrlString = matchInstance[1]; }
          else if (patternIndex >= 5) { extractedUrlString = matchInstance[0]; if (patternIndex === 6 && extractedUrlString.includes('/graphql')) { inferredMethod = "POST"; } }

          if (!extractedUrlString) continue;

          try {
            let fullEndpointURL;
            if (extractedUrlString.startsWith('/')) { fullEndpointURL = new URL(extractedUrlString, base).toString(); }
            else if (extractedUrlString.match(/^https?:\/\//)) { fullEndpointURL = extractedUrlString; }
            else { continue; }
            
            let tag = inferredMethod ? "[SCRIPT_EVIDENT]" : "[SCRIPT_URL_ONLY]";
            let methodPrefix = inferredMethod ? `${inferredMethod} ` : "";
            if (patternIndex === 6 && fullEndpointURL.includes('/graphql') && !inferredMethod) { tag = "[SCRIPT_EVIDENT]"; methodPrefix = "POST "; }
            pageData.endpoints.add(`${tag} ${methodPrefix}${fullEndpointURL}`);
          } catch (e) { /* Ignora URL malformati da script */ }
        }
      });
    });
    
    // Estrai URLs da script esterni, link[href], img[src] etc.
    $('script[src], link[href], img[src], source[src]').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('href');
      if (src) {
        try {
          const full = new URL(src, base).toString();
          pageData.endpoints.add(`[RESOURCE_URL] ${full}`); // Tagged as resource URL
          
          if (src.includes('react') || src.includes('vue') || src.includes('angular') || src.includes('ember') || src.includes('backbone')) {
            const framework = src.includes('react') ? 'React' : src.includes('vue') ? 'Vue.js' : src.includes('angular') ? 'Angular' : src.includes('ember') ? 'Ember' : 'Backbone';
            pageData.jsFrameworks.add(framework);
          }
        } catch (_) {}
      }
    });
    
    // Analizza SPA routes (placeholder, complex to implement robustly)
    // await page.evaluate(() => { /* ... SPA route analysis ... */ });
    
    // Esegui eventi click (potrebbe essere instabile o lento, usare con cautela)
    /*
    await page.evaluate(async () => {
      const buttons = document.querySelectorAll('button:not([type="submit"]):not([disabled]):not([style*="display: none"]):not([style*="visibility: hidden"])');
      for (const button of buttons) {
        try {
          button.click();
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (e) {}
      }
    });
    */
    
  } catch (err) {
    console.warn(`⚠️ Errore (extractInfo) per ${url}: ${err.message.split('\n')[0]}`);
    // Return partial data if an error occurs mid-extraction
  }
  return pageData;
}

async function processUrlAndExtractData(browser, url, depth) {
  if (visited.has(url) || depth > MAX_DEPTH) {
    return []; // Return empty array for new links if already visited or too deep
  }
  visited.add(url);
  console.log(`⏳ Processando [D:${depth}]: ${url}`);
  let page;
  try {
    page = await browser.newPage();
    await setupPage(page); // Setup page specific settings
    const extractedData = await extractInfo(url, page); // Extract data using the modified function

    // Merge data into global sets
    extractedData.links.forEach(link => linksFound.add(link));
    extractedData.forms.forEach(form => formsFound.add(form));
    extractedData.endpoints.forEach(endpoint => endpointsFound.add(endpoint));
    extractedData.reactComponents.forEach(comp => reactComponentsFound.add(comp));
    extractedData.jsFrameworks.forEach(fw => jsFrameworksDetected.add(fw));
    requestsToReplicate.push(...extractedData.requestsToReplicateForPage);

    return Array.from(extractedData.links); // Return new links found on this page
  } catch (error) {
    console.error(`❌ Errore grave processando ${url}: ${error.message.split('\n')[0]}`);
    return []; // Return empty array in case of critical error for this page
  } finally {
    if (page) {
      try {
        await page.close();
        console.log(`✅ Pagina chiusa: ${url}`);
      } catch (closeError) {
        console.warn(`⚠️ Errore chiudendo pagina ${url}: ${closeError.message.split('\n')[0]}`);
      }
    }
  }
}

async function crawl(startUrl) {
  console.log("Tentativo di avvio del browser con argomenti minimi...");
  const browser = await puppeteer.launch({
    headless: false, 
    defaultViewport: null, // Keep this for full visibility
    ignoreHTTPSErrors: true, // Keep for test sites
    args: [
      '--no-sandbox', // Often required
      // '--disable-setuid-sandbox', // Covered by no-sandbox usually
      // '--disable-dev-shm-usage', // More for CI/Docker
      // '--disable-web-security', // Remove for now
      // '--disable-features=IsolateOrigins,site-per-process,BlockInsecurePrivateNetworkRequests,OutOfBlinkCors', // Remove for now
      // '--disable-site-isolation-trials', // Remove for now
      // '--allow-running-insecure-content', // Remove for now
      '--start-maximized' 
    ]
  });
  console.log("Browser avviato con successo (si spera).");

  const queue = [{ url: startUrl, depth: 0 }];
  const activePages = new Map(); // url -> promise
  let urlCounter = 0;

  try {
    while (queue.length > 0 || activePages.size > 0) {
      while (queue.length > 0 && activePages.size < MAX_CONCURRENT_PAGES) {
        const item = queue.shift();
        if (!item || visited.has(item.url) || item.depth > MAX_DEPTH) {
          continue;
        }
        
        // Check again if visited, as it might have been added by another concurrent task
        if (visited.has(item.url)) continue;

        urlCounter++;
        console.log(`➕ Aggiungo task (${activePages.size + 1}/${MAX_CONCURRENT_PAGES}): ${item.url} (Tot: ${urlCounter})`);
        const promise = processUrlAndExtractData(browser, item.url, item.depth)
          .then(newLinks => {
            newLinks.forEach(link => {
              const linkInQueue = queue.some(qItem => qItem.url === link);
              if (!visited.has(link) && !linkInQueue && item.depth + 1 <= MAX_DEPTH) {
                queue.push({ url: link, depth: item.depth + 1 });
              }
            });
            activePages.delete(item.url);
            console.log(`➖ Task completato: ${item.url}. Attivi: ${activePages.size}, Coda: ${queue.length}`);
          })
          .catch(error => {
            console.error(`💀 Errore non gestito per ${item.url}: ${error.message.split('\n')[0]}`);
            activePages.delete(item.url);
            // Non reinserire nella coda in caso di errore grave per evitare loop infiniti
          });
        activePages.set(item.url, promise);
      }

      if (activePages.size > 0) {
        // Attendi che una qualsiasi delle pagine attive finisca
        await Promise.race(activePages.values());
      } else if (queue.length === 0) {
        // Se non ci sono pagine attive e la coda è vuota, abbiamo finito
        break;
      }
      // Piccolo delay per evitare spin-lock aggressivi se la coda si svuota temporaneamente
      // ma ci sono ancora pagine attive che potrebbero riempirla.
      if (queue.length === 0 && activePages.size > 0) {
          await sleep(100); 
      }
    }
  } catch (mainError) {
    console.error(`💥 Errore catastrofico nel crawler: ${mainError.message}`);
    // Potrebbe essere utile salvare i log o lo stato qui
  } finally {
    console.log("🚪 Chiudendo il browser...");
    await browser.close();
    console.log("Browser chiuso.");
  }
}

function saveResults() {
  // Crea cartella per i risultati
  const resultsDir = 'results';
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir);
  }
  
  // Salva tutti i risultati in file separati
  fs.writeFileSync(path.join(resultsDir, 'links.txt'), Array.from(linksFound).join('\n'));
  fs.writeFileSync(path.join(resultsDir, 'forms.json'), 
    JSON.stringify(Array.from(formsFound).map(form => JSON.parse(form)), null, 2)); // Pretty print JSON array
  fs.writeFileSync(path.join(resultsDir, 'endpoints.txt'), Array.from(endpointsFound).sort().join('\n')); // Sort for consistency
  fs.writeFileSync(path.join(resultsDir, 'frameworks.txt'), Array.from(jsFrameworksDetected).join('\n'));
  
  if (reactComponentsFound.size > 0) {
    fs.writeFileSync(path.join(resultsDir, 'react-components.txt'), 
      Array.from(reactComponentsFound).join('\n'));
  }
  
  fs.writeFileSync(path.join(resultsDir, 'requests.json'), 
    JSON.stringify(requestsToReplicate, null, 2));
  
  // Crea un report riassuntivo
  const summaryReport = {
    crawledUrls: Array.from(visited),
    totalLinks: linksFound.size,
    totalForms: formsFound.size,
    totalEndpoints: endpointsFound.size,
    detectedFrameworks: Array.from(jsFrameworksDetected),
    reactComponents: reactComponentsFound.size > 0 ? Array.from(reactComponentsFound) : [],
    timestamp: new Date().toISOString()
  };
  
  fs.writeFileSync(path.join(resultsDir, 'summary.json'), 
    JSON.stringify(summaryReport, null, 2));
  
  console.log('✅ Analisi COMPLETATA. Risultati salvati nella cartella "results":');
  console.log(`   - ${linksFound.size} link trovati`);
  console.log(`   - ${formsFound.size} form analizzati`);
  console.log(`   - ${endpointsFound.size} endpoint API scoperti`);
  console.log(`   - ${jsFrameworksDetected.size} framework JavaScript rilevati: ${Array.from(jsFrameworksDetected).join(', ')}`);
  if (reactComponentsFound.size > 0) {
    console.log(`   - ${reactComponentsFound.size} componenti React individuati`);
  }
}

// URL target da riga di comando o predefinito
const targetUrl = process.argv[2] || 'http://testhtml5.vulnweb.com';
if (!targetUrl) {
  console.error('❌ Inserisci un URL di destinazione. Esempio: node cr.js https://example.com');
  process.exit(1);
}

console.log(`🚀 Avvio analisi di: ${targetUrl}`);
console.log(`📋 Impostazioni: profondità massima=${MAX_DEPTH}, tempo attesa=${WAIT_TIME}ms`);

crawl(targetUrl)
  .then(() => {
    saveResults();
  })
  .catch(err => {
    console.error('❌ Errore durante l\'analisi:', err);
  });
