/** @typedef {import('./polyfills-loader-types').PolyfillsLoaderMiddlewareConfig} PolyfillsLoaderMiddlewareConfig */
/** @typedef {import('polyfills-loader').GeneratedFile} GeneratedFile */

/**
 * @typedef {object} IndexHTMLData
 * @property {string} indexHTML
 * @property {string} lastModified
 * @property {GeneratedFile[]} inlineScripts
 */

/* eslint-disable no-console */
import path from 'path';
import { URLSearchParams } from 'url';
import { injectPolyfillsLoader } from '../utils/inject-polyfills-loader.js';
import {
  isIndexHTMLResponse,
  getBodyAsString,
  toBrowserPath,
  isInlineScript,
  RequestCancelledError,
  toFilePath,
} from '../utils/utils.js';
import { getUserAgentCompat } from '../utils/user-agent-compat.js';

/**
 * Creates middleware which injects polyfills and code into the served application which allows
 * it to run on legacy browsers.
 *
 * @param {PolyfillsLoaderMiddlewareConfig} cfg
 */
export function createPolyfillsLoaderMiddleware(cfg) {
  // polyfills, keyed by url
  /** @type {Map<string, string>} */
  const polyfills = new Map();

  // index html data, keyed by url
  /** @type {Map<string, IndexHTMLData>} */
  const indexHTMLData = new Map();

  /** @type {import('koa').Middleware} */
  async function polyfillsLoaderMiddleware(ctx, next) {
    // serve polyfill from memory if url matches
    const polyfill = polyfills.get(ctx.url);
    if (polyfill) {
      ctx.body = polyfill;
      // aggresively cache polyfills, they are hashed so content changes bust the cache
      ctx.response.set('cache-control', 'public, max-age=31536000');
      ctx.response.set('content-type', 'text/javascript');
      return undefined;
    }
    const uaCompat = getUserAgentCompat(ctx);

    /**
     * serve extracted inline module if url matches. an inline module requests has this
     * structure:
     * `/inline-script-<index>?source=<index-html-path>`
     * for example:
     * `/inline-script-2?source=/src/index-html`
     * source query parameter is the index.html the inline module came from, index is the index
     * of the inline module in that index.html. We use these to look up the correct code to
     * serve
     */
    if (isInlineScript(ctx.url)) {
      const [url, queryString] = ctx.url.split('?');
      const params = new URLSearchParams(queryString);
      const data = indexHTMLData.get(
        uaCompat.browserTarget + decodeURIComponent(params.get('source')),
      );
      if (!data) {
        return undefined;
      }

      const name = path.basename(url);
      const inlineScript = data.inlineScripts.find(f => f.path.split('?')[0] === name);
      if (!inlineScript) {
        throw new Error(`Could not find inline module for ${ctx.url}`);
      }

      ctx.body = inlineScript.content;
      ctx.response.set('content-type', 'text/javascript');
      ctx.response.set('cache-control', 'no-cache');
      ctx.response.set('last-modified', data.lastModified);
      return undefined;
    }

    await next();

    // check if we are serving an index.html
    if (!(await isIndexHTMLResponse(ctx, cfg.appIndex))) {
      return undefined;
    }

    const lastModified = ctx.response.headers['last-modified'];

    // return cached index.html if it did not change
    const data = indexHTMLData.get(uaCompat.browserTarget + ctx.url);
    // if there is no lastModified cached, the HTML file is not served from the
    // file system
    if (data && data.lastModified && lastModified && data.lastModified === lastModified) {
      ctx.body = data.indexHTML;
      return undefined;
    }

    const indexFilePath = path.join(cfg.rootDir, toFilePath(ctx.url));

    try {
      // transforms index.html to make the code load correctly with the right polyfills and shims
      const htmlString = await getBodyAsString(ctx);
      const result = await injectPolyfillsLoader({
        htmlString,
        indexUrl: ctx.url,
        indexFilePath,
        transformJs: cfg.transformJs,
        compatibilityMode: cfg.compatibilityMode,
        polyfillsLoaderConfig: cfg.polyfillsLoaderConfig,
        uaCompat,
      });

      // set new index.html
      ctx.body = result.indexHTML;

      const polyfillsMap = new Map();
      result.polyfills.forEach(file => {
        polyfillsMap.set(file.path, file);
      });

      // cache index for later use
      indexHTMLData.set(uaCompat.browserTarget + ctx.url, {
        ...result,
        inlineScripts: result.inlineScripts,
        lastModified,
      });

      // cache polyfills for serving
      result.polyfills.forEach(p => {
        let root = ctx.url.endsWith('/') ? ctx.url : path.posix.dirname(ctx.url);
        if (!root.endsWith('/')) {
          root = `${root}/`;
        }
        polyfills.set(`${root}${toBrowserPath(p.path)}`, p.content);
      });
    } catch (error) {
      if (error instanceof RequestCancelledError) {
        return undefined;
      }
      throw error;
    }
    return undefined;
  }

  return polyfillsLoaderMiddleware;
}
