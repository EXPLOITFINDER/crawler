// advanced-crawler.js - Versione per applicazioni moderne (React, Vue, Angular, HTML5)
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';
import { URL } from 'url';

// Abilita il plugin stealth per eludere il rilevamento
// puppeteer.use(StealthPlugin()); // Temporarily disabled for debugging ERR_BLOCKED_BY_CLIENT

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

// Funzione ausiliaria per estrarre dati da JSON
function extractDataFromJson(jsonData, basePageUrl, pageData) {
    // Heuristics to find URLs or relevant data points in JSON
    if (typeof jsonData === 'object' && jsonData !== null) {
        for (const key in jsonData) {
            if (Object.prototype.hasOwnProperty.call(jsonData, key)) {
                const value = jsonData[key];
                if (typeof value === 'string') {
                    // Check for potential URLs
                    if (value.startsWith('/') || value.startsWith('http://') || value.startsWith('https://')) {
                        try {
                            const fullUrl = new URL(value, basePageUrl).toString().split('#')[0];
                            if (fullUrl.startsWith(new URL(basePageUrl).origin)) {
                                console.log(`ℹ️ JSON Extracted Link: ${fullUrl}`);
                                pageData.links.add(fullUrl);
                            } else {
                                // console.log(`ℹ️ JSON Extracted External Endpoint/URL: ${fullUrl}`);
                                pageData.endpoints.add(`[JSON_API_RESPONSE] ${fullUrl}`);
                            }
                        } catch (e) { /* ignore invalid urls */ }
                    }
                    // Add other heuristics here, e.g., checking for keywords like 'api', 'endpoint', 'token'
                    if (key.toLowerCase().includes('token') || key.toLowerCase().includes('session')) {
                         console.log(`ℹ️ JSON Potential Token/Session Data for key '${key}' found on ${basePageUrl}`);
                         pageData.endpoints.add(`[JSON_SENSITIVE_KEY] ${key} on ${basePageUrl}`);
                    }
                } else if (typeof value === 'object') {
                    extractDataFromJson(value, basePageUrl, pageData); // Recursive call for nested objects/arrays
                }
            }
        }
    } else if (Array.isArray(jsonData)) {
        jsonData.forEach(item => extractDataFromJson(item, basePageUrl, pageData));
    }
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

async function extractInfo(url, page, isInitialExtraction = true) {
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
    // Setup request interception and response handling only once per page object or if explicitly initial
    if (isInitialExtraction && !page._requestInterceptionSetupDone) {
      await page.setRequestInterception(true);
      page.on('request', request => {
        const requestData = { url: request.url(), method: request.method(), headers: request.headers(), postData: request.postData(), resourceType: request.resourceType() };
        if (request.method() !== 'GET') { 
            // console.log(`📋 Request to replicate (non-GET): ${request.method()} ${request.url()}`);
            pageData.requestsToReplicateForPage.push(requestData); 
        }
        if (request.resourceType() === 'xhr' || request.resourceType() === 'fetch' || request.url().includes('/api/') || request.url().includes('/graphql')) {
          // console.log(`🔗 Intercepted API call: ${request.method()} ${request.url()}`);
          pageData.endpoints.add(`[INTERCEPTED] ${request.method()} ${request.url()}`);
        }
        if (!request.isInterceptResolutionHandled()) {
            request.continue();
        }
      });

      page.on('response', async response => {
        const request = response.request();
        const responseUrl = response.url();
        const status = response.status();
        // Log API calls with non-2xx/3xx status
        if ((request.resourceType() === 'xhr' || request.resourceType() === 'fetch' || responseUrl.includes('/api/')) && (status < 200 || status >= 400)) {
            console.warn(`📉 API Response Error (${status}) for ${request.method()} ${responseUrl} on page ${url}`);
            pageData.endpoints.add(`[API_ERROR_${status}] ${request.method()} ${responseUrl}`);
        }
        if (response.headers()['content-type'] && response.headers()['content-type'].includes('application/json')) {
            try {
                const jsonResponse = await response.json();
                // console.log(`📦 JSON Response from ${responseUrl} on page ${url}:`, JSON.stringify(jsonResponse, null, 2));
                extractDataFromJson(jsonResponse, url, pageData);
            } catch (e) {
                // console.warn(`⚠️ Could not parse JSON response from ${responseUrl}: ${e.message}`);
            }
        }
      });
      page._requestInterceptionSetupDone = true;
      console.log(`🛠️ Request interception and response handling SET UP for new page context: ${url}`);
    }

    if (isInitialExtraction) {
        console.log(`🔄 Navigando (extractInfo - initial) a: ${url} (Timeout: 90s, WaitUntil: domcontentloaded)`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
        console.log(`✅ Navigazione iniziale completata per: ${url}. Ora imposto permessi.`);

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
        console.log(`⏳ Attesa post-navigazione/permessi (extractInfo - initial): ${url}`);
        await sleep(WAIT_TIME); // Wait for dynamic content to load after initial navigation

        // Scroll only on initial extraction
        await page.evaluate(async () => {
            await new Promise(resolve => {
                let totalHeight = 0; const distance = 100; const timer = setInterval(() => {
                    const scrollHeight = document.body.scrollHeight; window.scrollBy(0, distance); totalHeight += distance;
                    if (totalHeight >= scrollHeight) { clearInterval(timer); resolve(); }
                }, 100);
            });
        });
        console.log(`📜 Pagina scrollata (initial): ${url}`);
    } else {
        console.log(`♻️ Ri-analizzando pagina corrente (extractInfo - subsequent): ${page.url()} (originariamente ${url})`);
        // For subsequent extractions on the same page (e.g., after form submit),
        // we might not need to re-navigate. We just wait a bit for potential AJAX updates.
        await sleep(WAIT_TIME / 2); // Shorter wait for subsequent analysis
        console.log(`⏳ Attesa completata per ri-analisi (subsequent): ${page.url()}`);
    }
    
    const currentActualUrl = page.url(); // URL could have changed due to redirects or client-side navigation
    const baseForExtraction = new URL(currentActualUrl);

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
          fullUrl = `${currentActualUrl}${href}`; // Use currentActualUrl for fragment links
        } else if (href.startsWith('javascript:')) {
          return;
        } else {
          fullUrl = new URL(href, baseForExtraction).toString();
        }
        
        fullUrl = fullUrl.split('#')[0];
        
        if (fullUrl.startsWith(baseForExtraction.origin)) {
          pageData.links.add(fullUrl);
        }
      } catch (e) {
        // Ignora URL malformati
      }
    });

    // Estrazione form
    $('form').each((_, form) => {
      const action = $(form).attr('action') || currentActualUrl; // Use currentActualUrl as default action
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
        action: action.startsWith('http') ? action : new URL(action, baseForExtraction).toString(),
        method,
        id: formId,
        name: formName,
        class: formClass,
        fields: formData
      };
      pageData.forms.add(formDetails); // Store form object directly
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
            if (extractedUrlString.startsWith('/')) { fullEndpointURL = new URL(extractedUrlString, baseForExtraction).toString(); }
            else if (extractedUrlString.match(/^https?:\/\//)) { fullEndpointURL = extractedUrlString; }
            else { /* Might be a relative path not starting with /, or something else we ignore for now. */
                 if (baseForExtraction.pathname.endsWith('/') && !extractedUrlString.startsWith('/')) {
                    fullEndpointURL = new URL(baseForExtraction.pathname + extractedUrlString, baseForExtraction).toString();
                 } else if (!extractedUrlString.startsWith('/')) {
                    fullEndpointURL = new URL(baseForExtraction.pathname.substring(0, baseForExtraction.pathname.lastIndexOf('/') + 1) + extractedUrlString, baseForExtraction).toString();
                 } else {
                    continue;
                 }
            }
            
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
          const full = new URL(src, baseForExtraction).toString();
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

async function submitForm(page, formDetails, originalUrl) {
    console.log(`📝 Tentativo di sottomissione form su ${originalUrl} (Action: ${formDetails.action}, Method: ${formDetails.method})`);
    const formActionUrl = new URL(formDetails.action, originalUrl).toString();

    try {
        // Fill form fields
        for (const field of formDetails.fields) {
            try {
                const selector = field.id ? `#${field.id}` : field.name ? `[name="${field.name}"]` : null;
                if (!selector) continue;

                const element = await page.$(selector);
                if (!element) {
                    // console.warn(`   Form field not found: ${selector}`);
                    continue;
                }

                if (field.type === 'hidden') continue; // Skip hidden fields

                let valueToFill = '';
                switch (field.type) {
                    case 'text':
                    case 'textarea':
                        valueToFill = field.name.toLowerCase().includes('email') ? 'test@example.com' :
                                      field.name.toLowerCase().includes('search') ? 'test search' :
                                      field.name.toLowerCase().includes('query') ? 'test query' :
                                      field.name.toLowerCase().includes('name') ? 'Test Name' :
                                      'test';
                        break;
                    case 'email':
                        valueToFill = 'test@example.com';
                        break;
                    case 'password':
                        valueToFill = 'Password123!';
                        break;
                    case 'number':
                        valueToFill = '123';
                        break;
                    case 'tel':
                        valueToFill = '1234567890';
                        break;
                    case 'url':
                        valueToFill = 'http://example.com';
                        break;
                    case 'select-one': // For <select>
                    case 'select':
                        // Attempt to select the first non-disabled option, or the second if first is placeholder-like
                        await page.evaluate((sel, fieldName, fieldId) => {
                            const selectElement = fieldId ? document.getElementById(fieldId) :
                                                  fieldName ? document.querySelector(`select[name="${fieldName}"]`) : null;
                            if (selectElement && selectElement.options && selectElement.options.length > 0) {
                                if (selectElement.options.length > 1 && 
                                    (selectElement.options[0].disabled || selectElement.options[0].value === '' || selectElement.options[0].value === '-1')) {
                                    selectElement.value = selectElement.options[1].value;
                                } else {
                                    selectElement.value = selectElement.options[0].value;
                                }
                                selectElement.dispatchEvent(new Event('change', { bubbles: true }));
                            }
                        }, selector, field.name, field.id);
                        // console.log(`   Filled select ${selector}`);
                        continue; // Skip page.type for select
                    case 'checkbox':
                        // Check the checkbox if not already checked
                        if (!await element.isChecked()) {
                            await element.click();
                            // console.log(`   Checked checkbox ${selector}`);
                        }
                        continue;
                    case 'radio':
                        // For radio buttons, we'd ideally need to group them by name and select one.
                        // For simplicity, we'll try to click the first one found if part of a group.
                        // This might not be ideal for all cases.
                        if (!await element.isChecked()) {
                           // console.log(`   Clicking radio button ${selector}`);
                           await element.click();
                        }
                        continue;
                    default:
                        // console.log(`   Skipping field ${selector} with type ${field.type}`);
                        continue;
                }

                if (valueToFill) {
                    await page.type(selector, valueToFill, { delay: 20 });
                    // console.log(`   Filled ${selector} with "${valueToFill}"`);
                }
            } catch (fieldError) {
                console.warn(`   ⚠️ Errore compilando il campo ${field.name || field.id}: ${fieldError.message.split('\n')[0]}`);
            }
        }

        // Find and click submit button
        // Heuristic: look for input[type=submit], button[type=submit], or button containing "submit" or "search" etc.
        const submitButtonSelectors = [
            `form#${formDetails.id} input[type="submit"]`,
            `form[name="${formDetails.name}"] input[type="submit"]`,
            `form#${formDetails.id} button[type="submit"]`,
            `form[name="${formDetails.name}"] button[type="submit"]`,
            `form#${formDetails.id} button:not([type])`,
            `form[name="${formDetails.name}"] button:not([type])`,
            'input[type="submit"]', // More generic if form context fails
            'button[type="submit"]',
            'button',
        ];

        let submitButton = null;
        for (const sbSelector of submitButtonSelectors) {
            try {
                const buttons = await page.$$(sbSelector);
                for (const btn of buttons) {
                    const btnText = (await page.evaluate(el => el.innerText || el.value, btn) || '').toLowerCase();
                    const formOfButton = await page.evaluate(el => el.form ? (el.form.id || el.form.name) : null, btn);
                    
                    // Check if the button is within the current form or is a general submit button
                    if (formOfButton === formDetails.id || formOfButton === formDetails.name || (!formDetails.id && !formDetails.name)) {
                         if (sbSelector.includes('[type="submit"]') || 
                            btnText.includes('submit') || btnText.includes('search') || 
                            btnText.includes('login') || btnText.includes('signin') || 
                            btnText.includes('go') || btnText.includes('filter') ||
                            btnText.includes('applica') || btnText.includes('cerca') || btnText.includes('invia') || btnText.includes('continua') || btnText.includes('procedi')) {
                            submitButton = btn;
                            break;
                        }
                    }
                }
                if (submitButton) break;
            } catch (e) {
                // console.warn(`   Error searching for submit button with selector ${sbSelector}: ${e.message}`)
            }
        }

        if (submitButton) {
            console.log(`   ✅ Trovato bottone di submit. Tentativo di click.`);
            // It's often better to evaluate click in browser context for SPAs
            // await submitButton.click(); // This might sometimes be detached
            await page.evaluate(el => el.click(), submitButton);

            console.log(`   ⏳ Attesa dopo submit del form (Action: ${formActionUrl}, Method: ${formDetails.method})`);
            
            // Wait for navigation OR for network to be idle, with a timeout
            // This handles both traditional form submissions (navigation) and AJAX submissions (network idle)
            try {
                await Promise.race([
                    page.waitForNavigation({ waitUntil: 'networkidle0', timeout: WAIT_TIME * 2 }),
                    page.waitForNetworkIdle({ idleTime: WAIT_TIME / 2, timeout: WAIT_TIME * 2 })
                ]);
                console.log(`   🌊 Navigazione/Network idle dopo submit per ${formActionUrl}`);
            } catch (navError) {
                console.log(`   ⚠️ Timeout o errore attesa navigazione/network idle dopo submit per ${formActionUrl}. Potrebbe essere una SPA o nessun cambio di pagina: ${navError.message.split('\n')[0]}`);
                await sleep(WAIT_TIME); // Fallback wait
            }

        } else {
            console.warn(`   ⚠️ Nessun bottone di submit trovato per il form (Action: ${formActionUrl})`);
            // If no submit button, and it's a GET form, maybe try navigating to action URL with query params?
            // This is more complex and might not be desired. For now, we skip.
        }
    } catch (formSubmitError) {
        console.error(`   ❌ Errore durante il tentativo di sottomissione del form ${formDetails.action}: ${formSubmitError.message.split('\n')[0]}`);
    }
    return page.url(); // Return the current URL after submission attempt
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
    const initialExtractedData = await extractInfo(url, page, true); // Initial extraction is true

    // Merge initial data into global sets
    initialExtractedData.links.forEach(link => linksFound.add(link));
    initialExtractedData.forms.forEach(formObj => formsFound.add(JSON.stringify(formObj))); // Stringify form objects for global storage
    initialExtractedData.endpoints.forEach(endpoint => endpointsFound.add(endpoint));
    initialExtractedData.reactComponents.forEach(comp => reactComponentsFound.add(comp));
    initialExtractedData.jsFrameworks.forEach(fw => jsFrameworksDetected.add(fw));
    requestsToReplicate.push(...initialExtractedData.requestsToReplicateForPage);

    let newLinksFromPage = Array.from(initialExtractedData.links);

    // Now, iterate through forms found on the initial page load and try to submit them
    if (initialExtractedData.forms.size > 0 && depth < MAX_DEPTH) { // Only submit forms if not at max depth to avoid deep recursive submissions
        console.log(`📨 Trovati ${initialExtractedData.forms.size} forms su ${url}. Tentativo di sottomissione...`);
        for (const formDetail of initialExtractedData.forms) { // formDetail is an object here
            const urlBeforeSubmit = page.url();
            await submitForm(page, formDetail, url); // Submit the form using the same page object
            const urlAfterSubmit = page.url();
            
            console.log(`📄 Ri-estrazione informazioni da ${urlAfterSubmit} (dopo sottomissione form da ${url})`);
            // Re-extract info from the current page state (might be same or new URL)
            // Pass false for isInitialExtraction as we are on the same page object (or navigated)
            const postSubmitExtractedData = await extractInfo(urlAfterSubmit, page, false); 

            // Merge data found after form submission
            postSubmitExtractedData.links.forEach(link => {
                if (!linksFound.has(link)) {
                    console.log(`➕ Link scoperto post-form (${formDetail.action}): ${link}`);
                    linksFound.add(link);
                    newLinksFromPage.push(link); // Add to links to be crawled from this processing step
                }
            });
            postSubmitExtractedData.endpoints.forEach(endpoint => {
                if (!endpointsFound.has(endpoint)) {
                    console.log(`➕ Endpoint scoperto post-form (${formDetail.action}): ${endpoint}`);
                    endpointsFound.add(endpoint);
                }
            });
            postSubmitExtractedData.requestsToReplicateForPage.forEach(req => requestsToReplicate.push(req));
            // Potentially merge other data types like React components if they can change post-submit
            postSubmitExtractedData.reactComponents.forEach(comp => reactComponentsFound.add(comp));
            postSubmitExtractedData.jsFrameworks.forEach(fw => jsFrameworksDetected.add(fw));

            // If submission navigated to a new page that is different from the original form's action URL 
            // or the base URL (and is within scope), add it to visited and new links to crawl.
            // This helps capture redirects to new unique pages post-submission.
            if (urlAfterSubmit !== urlBeforeSubmit && !visited.has(urlAfterSubmit) && urlAfterSubmit.startsWith(new URL(url).origin)) {
                console.log(`🗺️ Navigazione a nuovo URL post-form: ${urlAfterSubmit}. Aggiungo ai visitati e alla coda (se non già presente).`);
                visited.add(urlAfterSubmit); // Mark as visited to avoid re-processing its initial state by the main loop
                if (!newLinksFromPage.includes(urlAfterSubmit)) {
                     newLinksFromPage.push(urlAfterSubmit);
                }
            }
        }
    }

    return newLinksFromPage; // Return new links found on this page (initial + post-form submissions)
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
  const browser = await puppeteer.launch({
    headless: false, // Changed to true for production/speed, false for debugging
    defaultViewport: null,
    ignoreHTTPSErrors: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // Recommended for running in Docker/CI
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process,BlockInsecurePrivateNetworkRequests,OutOfBlinkCors',
      '--disable-site-isolation-trials',
      '--allow-running-insecure-content',
      // '--start-maximized' // Might not be needed for headless
    ]
  });

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
