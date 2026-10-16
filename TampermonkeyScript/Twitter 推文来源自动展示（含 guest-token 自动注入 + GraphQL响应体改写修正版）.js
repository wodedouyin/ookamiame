// ==UserScript==
// @name         X/Twitter 去除页面广告 + 推文来源自动展示
// @namespace    https://greasyfork.org/zh-CN/users/1534803-ookamiame
// @version      1.2.6
// @description  自动在每条推文下方显示“Twitter for ...”来源，支持登录用户请求头，还原 iOS 插件逻辑；并在页面内改写 HomeTimeline / TweetDetail 响应体，去除广告
// @author       狼小雨
// @license      MIT
// @match        *://x.com/*
// @match        *://twitter.com/*
// @grant        GM_xmlhttpRequest
// @connect      api.twitter.com
// @run-at       document-start
// @downloadURL https://update.greasyfork.org/scripts/576075/XTwitter%20%E5%8E%BB%E9%99%A4%E9%A1%B5%E9%9D%A2%E5%B9%BF%E5%91%8A%20%2B%20%E6%8E%A8%E6%96%87%E6%9D%A5%E6%BA%90%E8%87%AA%E5%8A%A8%E5%B1%95%E7%A4%BA.user.js
// @updateURL https://update.greasyfork.org/scripts/576075/XTwitter%20%E5%8E%BB%E9%99%A4%E9%A1%B5%E9%9D%A2%E5%B9%BF%E5%91%8A%20%2B%20%E6%8E%A8%E6%96%87%E6%9D%A5%E6%BA%90%E8%87%AA%E5%8A%A8%E5%B1%95%E7%A4%BA.meta.js
// ==/UserScript==

(function () {
  'use strict';

  const DEBUG = true;
  const cache = new Map();
  let currentTweetID = null;
  let domObserver = null;

  function getCookie(name) {
    const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function log(...args) {
    if (DEBUG) console.log('[TweetSource]', ...args);
  }


  /**
   * ========= 页面内改写 GraphQL 响应体 =========
   * 目标：
   *   ^https?:\/\/x\.com\/i\/api\/graphql\/[^\/]+\/(HomeTimeline|TweetDetail)
   *
   * 说明：
   *   Userscript 不能像MITM代理工具一样在代理层直接改写响应体，
   *   所以这里通过向页面上下文注入脚本，包装 fetch / XMLHttpRequest，
   *   在页面真正消费 JSON 之前，对响应体进行同样的过滤处理。
   */
function injectGraphQLRewrite() {
  if (window.__TS_GRAPHQL_REWRITE_INJECTED__) return;
  window.__TS_GRAPHQL_REWRITE_INJECTED__ = true;

  function pageMain(debug) {
    /**
     * X 全站广告拦截引擎 v2.2
     *
     * 相比 v2：
     * - 修复全对象递归导致的 Maximum call stack size exceeded
     *
     * 相比 v2.1：
     * - 恢复安全兜底扫描
     * - 不再只依赖固定路径
     * - 对未知 Timeline 结构更友好
     */
    const TARGET_RE = /(?:^https?:\/\/(?:x|twitter)\.com\/i\/api\/graphql\/[^/]+\/(?:HomeTimeline|HomeLatestTimeline|TweetDetail|SearchTimeline|UserTweets|UserMedia|UserTweetsAndReplies|ListLatestTweetsTimeline|ExploreTimeline|Bookmarks|NotificationsTimeline)(?:\?|$))|(?:^\/i\/api\/graphql\/[^/]+\/(?:HomeTimeline|HomeLatestTimeline|TweetDetail|SearchTimeline|UserTweets|UserMedia|UserTweetsAndReplies|ListLatestTweetsTimeline|ExploreTimeline|Bookmarks|NotificationsTimeline)(?:\?|$))/i;
    const AD_API_RE = /(?:^https?:\/\/(?:x|twitter)\.com\/i\/api\/1\.1\/videoads\/v2\/prerolls\.json(?:\?|$))|(?:^\/i\/api\/1\.1\/videoads\/v2\/prerolls\.json(?:\?|$))/i;
    const AD_API_RES = [
  /(?:^https?:\/\/(?:x|twitter)\.com\/i\/api\/1\.1\/videoads\/v2\/prerolls\.json(?:\?|$))|(?:^\/i\/api\/1\.1\/videoads\/v2\/prerolls\.json(?:\?|$))/i,
  /(?:^https?:\/\/(?:x|twitter)\.com\/i\/api\/1\.1\/promoted_content\/)/i,
  /(?:^https?:\/\/(?:x|twitter)\.com\/i\/ads\/)/i
  ];

function isAdApiUrl(url) {
  return AD_API_RES.some(re => re.test(url));
}

    const REWRITE_MARK = '__ts_graphql_rewritten__';
    const EMPTY_MODULE_MARK = '__ts_empty_ad_module__';

    const MAX_SCAN_DEPTH = 9;
    const MAX_SCAN_NODES = 2500;
    const MAX_ARRAY_SCAN = 120;

    function dlog() {
      if (debug) console.log('[TweetSource][GraphQLRewrite]', ...arguments);
    }

    function safeParse(text) {
      try { return JSON.parse(text); } catch (_) { return null; }
    }

    function safeStringify(obj, fallback) {
      try { return JSON.stringify(obj); } catch (_) { return fallback; }
    }

    function resolveUrl(url) {
      try {
        return new URL(url, location.origin).toString();
      } catch (_) {
        return String(url || '');
      }
    }

    function mark(obj) {
      try {
        Object.defineProperty(obj, REWRITE_MARK, {
          value: true,
          configurable: true,
          enumerable: false
        });
      } catch (_) {}
      return obj;
    }

    function isMarked(obj) {
      try { return !!obj && !!obj[REWRITE_MARK]; } catch (_) { return false; }
    }

    function isPlainJSONLike(obj) {
      if (!obj || typeof obj !== 'object') return false;
      if (Array.isArray(obj)) return true;

      try {
        if (typeof Node !== 'undefined' && obj instanceof Node) return false;
        if (typeof Window !== 'undefined' && obj instanceof Window) return false;
        if (typeof Event !== 'undefined' && obj instanceof Event) return false;
        if (typeof Response !== 'undefined' && obj instanceof Response) return false;
        if (typeof Request !== 'undefined' && obj instanceof Request) return false;
        if (typeof Headers !== 'undefined' && obj instanceof Headers) return false;
      } catch (_) {}

      const proto = Object.getPrototypeOf(obj);
      return proto === Object.prototype || proto === null;
    }

    function getGraphQLRoot(obj) {
      if (!obj || typeof obj !== 'object') return null;

      // fetch / XHR 层：{ data: ... }
      if (obj.data && typeof obj.data === 'object') return obj.data;

      // Promise 层有时已经被 apiClient 解包为 data 内部对象
      return obj;
    }
      function isQuoteRelatedNode(node) {
  if (!node || typeof node !== 'object') return false;

  return !!(
    node.quoted_status_result ||
    node.quotedRefResult ||
    node.quoted_status_permalink ||
    node.quoted_tweet ||
    node.quotedTweet ||
    node?.legacy?.quoted_status_id_str ||
    node?.tweet?.legacy?.quoted_status_id_str
  );
}

    function maybeTimelineCandidate(obj) {
      if (!obj || typeof obj !== 'object') return false;
      if (!isPlainJSONLike(obj)) return false;

      const root = getGraphQLRoot(obj);
      if (!root || typeof root !== 'object') return false;

      return !!(
        obj.data ||
        root.home ||
        root.user ||
        root.search_by_raw_query ||
        root.threaded_conversation_with_injections_v2 ||
        root.list ||
        root.explore ||
        root.bookmark_timeline_v2 ||
        root.bookmarks ||
        root.notifications_timeline ||
        root.viewer ||
        root.instructions ||
        root.entries ||
        root.timeline
      );
    }

    function deepTextContains(value, keywords) {
      if (!value) return false;
      const text = String(value);
      return keywords.some(k => text.includes(k));
    }

    function getItemContent(node) {
      return (
        node?.content?.itemContent ||
        node?.itemContent ||
        node?.item?.itemContent ||
        node?.item?.content?.itemContent ||
        null
      );
    }

    function getTweetResult(node) {
      const itemContent = getItemContent(node);
      return (
        itemContent?.tweet_results?.result ||
        itemContent?.tweetResult?.result ||
        node?.tweet_results?.result ||
        node?.tweetResult?.result ||
        null
      );
    }

    function getNestedSource(node) {
      const itemContent = getItemContent(node);
      const result = getTweetResult(node);

      return (
        itemContent?.tweet_results?.result?.source ||
        itemContent?.tweet_results?.result?.tweet?.source ||
        itemContent?.tweet_results?.result?.legacy?.source ||
        itemContent?.tweet_results?.result?.tweet?.legacy?.source ||
        result?.source ||
        result?.tweet?.source ||
        result?.legacy?.source ||
        result?.tweet?.legacy?.source ||
        ''
      );
    }

    function getClientComponent(node) {
      return (
        node?.content?.clientEventInfo?.component ||
        node?.content?.clientEventInfo?.element ||
        node?.clientEventInfo?.component ||
        node?.clientEventInfo?.element ||
        node?.item?.clientEventInfo?.component ||
        node?.item?.clientEventInfo?.element ||
        ''
      );
    }

    function hasPromotedMetadata(node) {
      const itemContent = getItemContent(node);
      const result = getTweetResult(node);

      return !!(
        node?.promotedMetadata ||
        node?.promoted_metadata ||
        node?.content?.promotedMetadata ||
        node?.content?.promoted_metadata ||
        node?.content?.itemContent?.promotedMetadata ||
        node?.content?.itemContent?.promoted_metadata ||
        node?.itemContent?.promotedMetadata ||
        node?.itemContent?.promoted_metadata ||
        node?.item?.itemContent?.promotedMetadata ||
        node?.item?.itemContent?.promoted_metadata ||
        itemContent?.promotedMetadata ||
        itemContent?.promoted_metadata ||
        result?.promotedMetadata ||
        result?.promoted_metadata ||
        result?.legacy?.promoted_metadata ||
        result?.tweet?.promotedMetadata ||
        result?.tweet?.promoted_metadata ||
        result?.tweet?.legacy?.promoted_metadata
      );
    }

    function isPromoted(node) {
      if (!node || typeof node !== 'object') return false;

          // 关键：引用推文结构永远不按广告节点删除
      if (isQuoteRelatedNode(node)) return false;

      if (node[EMPTY_MODULE_MARK]) return true;

      const entryId = String(node.entryId || node.entry_id || '');
      const itemEntryId = String(node.item?.entryId || node.item?.entry_id || '');
      const component = String(getClientComponent(node) || '');
      const source = String(getNestedSource(node) || '');
      const displayType = String(getItemContent(node)?.tweetDisplayType || '');

      const socialContext = String(
        node?.content?.socialContext?.text ||
        node?.item?.socialContext?.text ||
        getItemContent(node)?.socialContext?.text ||
        ''
      );

      return (
        entryId.includes('promoted') ||
        itemEntryId.includes('promoted') ||
        component.includes('promoted') ||
        component.includes('promotion') ||
        displayType.includes('Promoted') ||
        hasPromotedMetadata(node) ||
        source.includes('Ads Manager') ||
        source.includes('Twitter Ads') ||
        source.includes('X Ads') ||
        deepTextContains(socialContext, ['Promoted', 'Sponsored', '广告', '推广', '赞助'])
      );
    }

    function filterArray(arr, stats, seen, depth) {
      if (!Array.isArray(arr)) return arr;

      return arr
        .map(item => pruneTimelineNode(item, stats, seen, depth + 1))
        .filter(item => {
          const bad = isPromoted(item);
          if (bad) {
            stats.removed++;
            dlog('❌ 去除广告节点：', item?.entryId || item?.item?.entryId || item?.entry_id);
          }
          return !bad;
        });
    }

    function pruneTimelineNode(node, stats, seen, depth) {
      if (!node || typeof node !== 'object') return node;
      if (depth > 24) return node;
      if (seen.has(node)) return node;

      seen.add(node);

      if (Array.isArray(node)) {
        return filterArray(node, stats, seen, depth);
      }

      if (Array.isArray(node.entries)) {
        node.entries = filterArray(node.entries, stats, seen, depth);
      }

      if (Array.isArray(node.items)) {
        const before = node.items.length;
        node.items = filterArray(node.items, stats, seen, depth);

        // 详情页里广告模块的 items 被删空后，也删除整个模块
        if (before > 0 && node.items.length === 0) {
          try {
            Object.defineProperty(node, EMPTY_MODULE_MARK, {
              value: true,
              configurable: true,
              enumerable: false
            });
          } catch (_) {}
        }
      }

      if (node.content && Array.isArray(node.content.items)) {
        const before = node.content.items.length;
        node.content.items = filterArray(node.content.items, stats, seen, depth);

        if (before > 0 && node.content.items.length === 0) {
          try {
            Object.defineProperty(node, EMPTY_MODULE_MARK, {
              value: true,
              configurable: true,
              enumerable: false
            });
          } catch (_) {}
        }
      }

      if (node.addEntries && Array.isArray(node.addEntries.entries)) {
        node.addEntries.entries = filterArray(node.addEntries.entries, stats, seen, depth);
      }

      if (node.replaceEntry && node.replaceEntry.entry) {
        const entry = pruneTimelineNode(node.replaceEntry.entry, stats, seen, depth + 1);
        if (isPromoted(entry)) {
          stats.removed++;
          dlog('❌ 去除广告 replaceEntry：', entry?.entryId);
          node.replaceEntry.entry = null;
        } else {
          node.replaceEntry.entry = entry;
        }
      }

      // 只进入 timeline 相关安全子结构，不再全对象盲扫
      const safeChildKeys = [
        'content',
        'item',
        'itemContent',
        'timeline',
        'timelineModule',
        'moduleItems',
        'addEntries',
        'replaceEntry'
      ];

      for (const key of safeChildKeys) {
        const value = node[key];
        if (value && typeof value === 'object') {
          node[key] = pruneTimelineNode(value, stats, seen, depth + 1);
        }
      }

      return node;
    }

    function processInstructions(instructions, stats, seen) {
      if (!Array.isArray(instructions)) return;
      for (const ins of instructions) {
        pruneTimelineNode(ins, stats, seen, 0);
      }
    }

    function processEntries(entries, stats, seen) {
      if (!Array.isArray(entries)) return entries;
      return filterArray(entries, stats, seen, 0);
    }

    function collectTimelineSets(obj, enableDiscovery) {
      const root = getGraphQLRoot(obj);
      const sets = [];
      const dedupe = new WeakMap();

      function add(parent, key, type, label) {
        if (!parent || typeof parent !== 'object') return;
        if (!Array.isArray(parent[key])) return;

        let keys = dedupe.get(parent);
        if (!keys) {
          keys = new Set();
          dedupe.set(parent, keys);
        }

        const id = `${type}:${key}`;
        if (keys.has(id)) return;
        keys.add(id);

        sets.push({ parent, key, type, label });
      }

      if (!root || typeof root !== 'object') return sets;

      // ===== 固定路径：优先处理 =====

      add(root.home?.home_timeline_urt, 'instructions', 'instructions', 'HomeTimeline');
      add(root.home?.home_latest_timeline_urt, 'instructions', 'instructions', 'HomeLatestTimeline');

      add(root.threaded_conversation_with_injections_v2, 'instructions', 'instructions', 'TweetDetail');

      add(root.search_by_raw_query?.search_timeline?.timeline, 'instructions', 'instructions', 'SearchTimeline');

      add(root.user?.result?.timeline?.timeline, 'instructions', 'instructions', 'UserTimeline');
      add(root.user?.result?.timeline_v2?.timeline, 'instructions', 'instructions', 'UserTimelineV2');
      add(root.user_result_by_screen_name?.result?.timeline?.timeline, 'instructions', 'instructions', 'UserByScreenNameTimeline');

      add(root.list?.tweets_timeline?.timeline, 'instructions', 'instructions', 'ListTimeline');
      add(root.list?.tweets_timeline_v2?.timeline, 'instructions', 'instructions', 'ListTimelineV2');

      add(root.explore?.explore_timeline?.timeline, 'instructions', 'instructions', 'ExploreTimeline');

      add(root.bookmark_timeline_v2?.timeline, 'instructions', 'instructions', 'Bookmarks');
      add(root.bookmarks?.timeline, 'instructions', 'instructions', 'BookmarksAlt');

      add(root.notifications_timeline?.timeline, 'instructions', 'instructions', 'NotificationsTimeline');
      add(root.viewer?.notifications_timeline?.timeline, 'instructions', 'instructions', 'ViewerNotificationsTimeline');

      // 有些 Promise 层已经直接返回 timeline 子对象
      add(root, 'instructions', 'instructions', 'RootInstructions');
      add(root, 'entries', 'entries', 'RootEntries');

      if (!enableDiscovery) return sets;

      // ===== 安全兜底扫描：用于覆盖未知页面 / 新路径 =====
      const visited = new WeakSet();
      let scanned = 0;
      const queue = [{ node: root, depth: 0 }];

      const skipKeys = new Set([
        'legacy',
        'entities',
        'extended_entities',
        'quoted_status_result',
        'retweeted_status_result',
        'tweet_results',
        'tweetResult',
        'user_results',
        'note_tweet',
        'media',
        'urls'
      ]);

      while (queue.length && scanned < MAX_SCAN_NODES) {
        const { node, depth } = queue.shift();
        if (!isPlainJSONLike(node)) continue;
        if (visited.has(node)) continue;

        visited.add(node);
        scanned++;

        if (!Array.isArray(node)) {
          add(node, 'instructions', 'instructions', 'DiscoveredInstructions');
          add(node, 'entries', 'entries', 'DiscoveredEntries');

          if (node.addEntries) add(node.addEntries, 'entries', 'entries', 'DiscoveredAddEntries');

          if (depth >= MAX_SCAN_DEPTH) continue;

          let keys = [];
          try { keys = Object.keys(node); } catch (_) { keys = []; }

          for (const key of keys) {
            if (skipKeys.has(key)) continue;
            if (key === 'instructions' || key === 'entries' || key === 'items') continue;

            const value = node[key];
            if (isPlainJSONLike(value)) {
              queue.push({ node: value, depth: depth + 1 });
            }
          }
        } else {
          if (depth >= MAX_SCAN_DEPTH) continue;

          for (let i = 0; i < Math.min(node.length, MAX_ARRAY_SCAN); i++) {
            const value = node[i];
            if (isPlainJSONLike(value)) {
              queue.push({ node: value, depth: depth + 1 });
            }
          }
        }
      }

      return sets;
    }

    function rewriteGraphQL(data, enableDiscovery) {
      if (!data || typeof data !== 'object') {
        return { touched: false, removed: 0 };
      }

      const sets = collectTimelineSets(data, enableDiscovery);
      if (!sets.length) {
        return { touched: false, removed: 0 };
      }

      const stats = { removed: 0 };
      const seen = new WeakSet();

      try {
        for (const set of sets) {
          if (set.type === 'instructions') {
            processInstructions(set.parent[set.key], stats, seen);
          } else if (set.type === 'entries') {
            set.parent[set.key] = processEntries(set.parent[set.key], stats, seen);
          }
        }
      } catch (e) {
        dlog('⚠️ GraphQL 重写失败：', e);
      }

      if (stats.removed > 0) {
        dlog(`✅ GraphQL 广告过滤完成，移除 ${stats.removed} 条`);
      }

      return { touched: true, removed: stats.removed };
    }

      function stripAdLikeObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;

          /**
   * 视频广告对象兜底。
   */
          const adKeys = [
              'ads',
              'ad',
              'prerolls',
              'preroll',
              'vast',
              'vast_url',
              'vastUrl',
              'promoted_content',
              'promotedContent'
          ];

          let touched = false;

          for (const key of adKeys) {
              if (!(key in obj)) continue;

              if (Array.isArray(obj[key])) {
                  obj[key] = [];
                  touched = true;
              } else if (obj[key] && typeof obj[key] === 'object') {
                  obj[key] = null;
                  touched = true;
              } else {
                  obj[key] = null;
                  touched = true;
              }
          }

          if (touched) {
              try {
                  Object.defineProperty(obj, '__ts_ad_object_stripped__', {
                      value: true,
                      configurable: true,
                      enumerable: false
                  });
              } catch (_) {}
          }

          return obj;
      }

    function rewriteGraphQLObject(obj) {
      if (!obj || typeof obj !== 'object') return obj;
      if (isMarked(obj)) return obj;
      if (!maybeTimelineCandidate(obj)) return obj;

      // Promise 层也启用安全 discovery，但有深度和节点上限
      const result = rewriteGraphQL(obj, true);

      if (result.touched) {
        mark(obj);
        if (result.removed > 0) {
          dlog(`✅ Promise 层 GraphQL 对象已改写，移除 ${result.removed} 条`);
        }
      }

      return obj;
    }

      function buildEmptyAdApiBody(url, originalText) {
  /**
   * videoads/v2/prerolls.json 通常用于视频前贴片广告。
   * 这里返回一个“合法但无广告”的 JSON，避免前端 JSON.parse 报错。
   */
  if (/\/i\/api\/1\.1\/videoads\/v2\/prerolls\.json/i.test(url)) {
    return JSON.stringify({
      ads: [],
      prerolls: [],
      videos: [],
      vast: null,
      ad: null,
      reason: 'blocked_by_userscript'
    });
  }

  /**
   * 其它未知广告接口兜底。
   */
  return JSON.stringify({
    ads: [],
    items: [],
    entries: [],
    data: [],
    reason: 'blocked_by_userscript'
  });
}

    function rewriteResponseBody(url, text) {
      const data = safeParse(text);
      if (!data) return text;

      // fetch / XHR 是目标 URL，允许安全 discovery
      const result = rewriteGraphQL(data, true);
      if (!result.touched) return text;

      mark(data);
      return safeStringify(data, text);
    }

    function buildSyntheticResponse(res, bodyText) {
      const headers = new Headers();

      try {
        res.headers.forEach((value, key) => headers.set(key, value));
      } catch (_) {}

      const newRes = new Response(bodyText, {
        status: res.status,
        statusText: res.statusText,
        headers
      });

      try {
        Object.defineProperty(newRes, 'url', {
          value: res.url,
          configurable: true
        });
      } catch (_) {}

      try {
        Object.defineProperty(newRes, 'redirected', {
          value: res.redirected,
          configurable: true
        });
      } catch (_) {}

      return newRes;
    }

    function patchFetch() {
      if (!window.fetch || window.__TS_FETCH_PATCHED__) return;
      window.__TS_FETCH_PATCHED__ = true;

      const rawFetch = window.fetch.bind(window);

      window.fetch = async function (input, init) {
        const res = await rawFetch(input, init);

        let url = '';
        try {
          url = typeof input === 'string'
            ? input
            : (input?.url || res.url || '');
        } catch (_) {}

        url = resolveUrl(url);

/**
 * 非 GraphQL 广告接口：直接返回空广告 JSON
 */
if (typeof isAdApiUrl === 'function' && isAdApiUrl(url)) {
  try {
    const emptyBody = buildEmptyAdApiBody(url, '');
    dlog('🛑 fetch 广告接口已拦截：', url);
    return buildSyntheticResponse(res, emptyBody);
  } catch (e) {
    dlog('⚠️ fetch 广告接口拦截失败：', e);
    return res;
  }
}

if (!TARGET_RE.test(url)) return res;

        try {
          const originalText = await res.clone().text();
          const rewrittenText = rewriteResponseBody(url, originalText);

          if (rewrittenText !== originalText) {
            dlog('✅ fetch 响应体已改写：', url);
          } else {
            dlog('ℹ️ fetch 命中目标接口但未发生字段变化：', url);
          }

          return buildSyntheticResponse(res, rewrittenText);
        } catch (e) {
          dlog('⚠️ fetch 改写失败：', e);
          return res;
        }
      };
    }

    function patchXHR() {
      const XHR = window.XMLHttpRequest;
      if (!XHR || !XHR.prototype || window.__TS_XHR_PATCHED__) return;
      window.__TS_XHR_PATCHED__ = true;

      const rawOpen = XHR.prototype.open;
      const rawSend = XHR.prototype.send;

      XHR.prototype.open = function (method, url) {
        try { this.__ts_graphql_url = resolveUrl(url); } catch (_) {}
        return rawOpen.apply(this, arguments);
      };

      XHR.prototype.send = function () {
        const xhr = this;

        function tryRewrite() {
          try {
            const url = xhr.__ts_graphql_url || '';
              if (xhr.readyState !== 4) return;

              /**
 * 非 GraphQL 广告接口：XHR 层直接改成空广告 JSON
 */
              if (typeof isAdApiUrl === 'function' && isAdApiUrl(url)) {
                  const emptyBody = buildEmptyAdApiBody(url, '');

                  Object.defineProperty(xhr, 'responseText', {
                      configurable: true,
                      get() {
                          return emptyBody;
                      }
                  });

                  Object.defineProperty(xhr, 'response', {
                      configurable: true,
                      get() {
                          return xhr.responseType === 'json' ? safeParse(emptyBody) : emptyBody;
                      }
                  });

                  dlog('🛑 XHR 广告接口已拦截：', url);
                  return;
              }

              if (!TARGET_RE.test(url)) return;

            const originalText = xhr.responseText;
            if (typeof originalText !== 'string' || !originalText) return;

            const rewritten = rewriteResponseBody(url, originalText);
            if (rewritten === originalText) {
              dlog('ℹ️ XHR 命中目标接口但未发生字段变化：', url);
              return;
            }

            const rewrittenJson = safeParse(rewritten);

            Object.defineProperty(xhr, 'responseText', {
              configurable: true,
              get() {
                return rewritten;
              }
            });

            Object.defineProperty(xhr, 'response', {
              configurable: true,
              get() {
                return xhr.responseType === 'json' ? rewrittenJson : rewritten;
              }
            });

            dlog('✅ XHR 响应体已改写：', url);
          } catch (e) {
            dlog('⚠️ XHR 改写失败：', e);
          }
        }

        xhr.addEventListener('readystatechange', tryRewrite);
        return rawSend.apply(this, arguments);
      };
    }

    function patchPromiseThen() {
      if (Promise.prototype.__TS_PROMISE_THEN_PATCHED__) return;
      Promise.prototype.__TS_PROMISE_THEN_PATCHED__ = true;

      const rawThen = Promise.prototype.then;

      Promise.prototype.then = function (onFulfilled, onRejected) {
        const wrappedFulfilled = typeof onFulfilled === 'function'
          ? function (value) {
              try {
                if (maybeTimelineCandidate(value)) {
                  rewriteGraphQLObject(value);
                }
                  if (value && typeof value === 'object') {
                      stripAdLikeObject(value);
                  }
              } catch (e) {
                dlog('⚠️ Promise.then 对象改写失败：', e);
              }

              return onFulfilled.call(this, value);
            }
          : onFulfilled;

        return rawThen.call(this, wrappedFulfilled, onRejected);
      };

      dlog('✅ Promise.then GraphQL 对象改写层已启用');
    }

    patchFetch();
    patchXHR();
    patchPromiseThen();

    dlog('🚀 X 全站广告拦截引擎 v2.2 已注入');
  }

  function waitForNonceAndInject(payload, timeoutMs = 4000, intervalMs = 50) {
    const start = Date.now();

    function tryInject() {
      const nonceNode = document.querySelector('script[nonce]');
      const nonce = nonceNode?.nonce || nonceNode?.getAttribute('nonce');

      if (!nonce && Date.now() - start < timeoutMs) {
        setTimeout(tryInject, intervalMs);
        return;
      }

      const script = document.createElement('script');
      if (nonce) script.setAttribute('nonce', nonce);
      script.textContent = `;(${pageMain.toString()})(${JSON.stringify(payload.debug)});`;
      (document.head || document.documentElement).appendChild(script);
      script.remove();
    }

    tryInject();
  }

  waitForNonceAndInject({ debug: DEBUG });
}

//推文来源展示

    /**
    在NeoFreeBird iOS插件的源代码中有默认请求cookie参数，所以目前不需要从本地浏览器中提取，因为这个接口是twitter默认给手机客户端设计的，所以部分参数是在web端没有的，在ios源码中，如果该参数失效（401）则提取客户端内的参数，

    这个接口会返回哪里能找到“Twitter for …”(发帖的客户端类型)
https://api.twitter.com/2/timeline/conversation/<tweetID>.json?...（这是 Twitter web 客户端用的内部/私有接口）返回的 JSON 常见结构类似（简化）：

    {
  "globalObjects": {
    "tweets": {
      "<tweetID>": {
        "id_str": "...",
        "full_text": "...",
        "source": "<a href=\"http://twitter.com/download/iphone\" rel=\"nofollow\">Twitter for iPhone</a>",
        ...
      },
      ...
    },
    "users": { ... }
  },
  ...
}

    也就是说，source 通常位于 globalObjects.tweets[tweetID].source，且它是包含 HTML 标签的字符串（<a ...>显示文本</a>）。所以任务就是取到该字段并把 HTML 标签去掉，得到 Twitter for iPhone / Twitter Web App 等来源文本

    以下是objc源码：
    + (void)fetchSourceForTweetID:(NSString *)tweetID {
    if (!tweetID) return;

    // Defer the entire operation to our concurrent queue to handle state checks and request creation safely
    dispatch_async(sourceLabelDataQueue, ^{
        @try {
            // Initialize dictionaries if needed
            if (!tweetSources) tweetSources = [NSMutableDictionary dictionary];
            if (!fetchTimeouts) fetchTimeouts = [NSMutableDictionary dictionary];
            if (!fetchRetries) fetchRetries = [NSMutableDictionary dictionary];
            if (!fetchPending) fetchPending = [NSMutableDictionary dictionary];

            // Simple cache size management
            if (tweetSources.count > MAX_SOURCE_CACHE_SIZE) {
                // Pruning is now async, so we just call it
                [self pruneSourceCachesIfNeeded];
            }

        // Skip if already pending or has valid result
        if ([fetchPending[tweetID] boolValue] ||
            (tweetSources[tweetID] && ![tweetSources[tweetID] isEqualToString:@""] && ![tweetSources[tweetID] isEqualToString:@"Source Unavailable"])) {
            return;
        }

        // Check retry limit
        NSInteger retryCount = [fetchRetries[tweetID] integerValue];
        if (retryCount >= MAX_CONSECUTIVE_FAILURES) {
            tweetSources[tweetID] = @"Source Unavailable";
            return;
        }

        fetchPending[tweetID] = @(YES);
        fetchRetries[tweetID] = @(retryCount + 1);

                // Set simple timeout on main thread
        dispatch_async(dispatch_get_main_queue(), ^{
            NSTimer *timeoutTimer = [NSTimer scheduledTimerWithTimeInterval:8.0
                                                                    target:self
                                                                  selector:@selector(timeoutFetchForTweetID:)
                                                                  userInfo:@{@"tweetID": tweetID}
                                                                   repeats:NO];
            dispatch_barrier_async(sourceLabelDataQueue, ^{
                fetchTimeouts[tweetID] = timeoutTimer;
            });
        });

        // Build request
        NSString *urlString = [NSString stringWithFormat:@"https://api.twitter.com/2/timeline/conversation/%@.json?include_ext_alt_text=true&include_reply_count=true&tweet_mode=extended", tweetID];
        NSURL *url = [NSURL URLWithString:urlString];
        if (!url) {
            [self handleFetchFailure:tweetID];
            return;
        }

        NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
        request.HTTPMethod = @"GET";
        request.timeoutInterval = 7.0;

        // Get cookies
        if (!cookieCache) {
            [self loadCachedCookies];
        }
        NSDictionary *cookiesToUse = cookieCache;

        // Check if using real cookies
        BOOL usingRealCookies = cookiesToUse &&
                               ![cookiesToUse[@"ct0"] isEqualToString:@"91cc6876b96a35f91adeedc4ef149947c4d58907ca10fc2b17f64b17db0cccfb714ae61ede34cf34866166dcaf8e1c3a86085fa35c41aacc3e3927f7aa1f9b850b49139ad7633344059ff04af302d5d3"];

        // Build headers
        NSMutableArray *cookieStrings = [NSMutableArray array];
        for (NSString *cookieName in cookiesToUse) {
            [cookieStrings addObject:[NSString stringWithFormat:@"%@=%@", cookieName, cookiesToUse[cookieName]]];
        }

        [request setValue:@"Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA" forHTTPHeaderField:@"Authorization"];
        [request setValue:@"OAuth2Session" forHTTPHeaderField:@"x-twitter-auth-type"];
        [request setValue:@"CFNetwork/1331.0.7 Darwin/25.2.0" forHTTPHeaderField:@"User-Agent"];
        [request setValue:@"gzip" forHTTPHeaderField:@"Accept-Encoding"];
        [request setValue:cookiesToUse[@"ct0"] forHTTPHeaderField:@"x-csrf-token"];
        [request setValue:[cookieStrings componentsJoinedByString:@"; "] forHTTPHeaderField:@"Cookie"];

        // Execute request
        NSURLSession *session = [NSURLSession sharedSession];
        NSURLSessionDataTask *task = [session dataTaskWithRequest:request
                                                completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
            // The completion handler runs on a background thread
            // We must use our queue to modify shared state
            dispatch_barrier_async(sourceLabelDataQueue, ^{
                @try {
                    // Cleanup timeout
                    NSTimer *timer = fetchTimeouts[tweetID];
                    if (timer) {
                        dispatch_async(dispatch_get_main_queue(), ^{
                            [timer invalidate];
                        });
                        [fetchTimeouts removeObjectForKey:tweetID];
                    }
                    fetchPending[tweetID] = @(NO);

                // Handle errors
                if (error || !data) {
                    [self handleFetchFailure:tweetID];
                    return;
                }

                NSHTTPURLResponse *httpResponse = (NSHTTPURLResponse *)response;

                // Handle auth errors with fallback
                if ((httpResponse.statusCode == 401 || httpResponse.statusCode == 403) && usingRealCookies && retryCount == 1) {
                    // Try hardcoded cookies once
                    NSDictionary *hardcodedCookies = @{
                        @"ct0": @"91cc6876b96a35f91adeedc4ef149947c4d58907ca10fc2b17f64b17db0cccfb714ae61ede34cf34866166dcaf8e1c3a86085fa35c41aacc3e3927f7aa1f9b850b49139ad7633344059ff04af302d5d3",
                        @"auth_token": @"71fc90d6010d76ec4473b3e42c6802a8f1185316",
                        @"twid": @"u%3D1930115366878871552"
                    };
                                            [self cacheCookies:hardcodedCookies];
                        [self fetchSourceForTweetID:tweetID]; // Re-call, which will be queued
                        return;
                }

                if (httpResponse.statusCode != 200) {
                    [self handleFetchFailure:tweetID];
                    return;
                }

                // Parse JSON
                NSError *jsonError;
                NSDictionary *json = [NSJSONSerialization JSONObjectWithData:data options:0 error:&jsonError];
                if (jsonError || !json) {
                    [self handleFetchFailure:tweetID];
                    return;
                }

                // Extract source
                NSDictionary *tweets = json[@"globalObjects"][@"tweets"];
                NSDictionary *tweetData = tweets[tweetID];

                // Try alternate ID format if not found
                if (!tweetData) {
                    for (NSString *key in tweets) {
                        if ([key longLongValue] == [tweetID longLongValue]) {
                            tweetData = tweets[key];
                            break;
                        }
                    }
                }

                NSString *sourceHTML = tweetData[@"source"];
                NSString *sourceText = @"Unknown Source";

                if (sourceHTML) {
                    NSRange startRange = [sourceHTML rangeOfString:@">"];
                    NSRange endRange = [sourceHTML rangeOfString:@"</a>"];
                    if (startRange.location != NSNotFound && endRange.location != NSNotFound && startRange.location + 1 < endRange.location) {
                        sourceText = [sourceHTML substringWithRange:NSMakeRange(startRange.location + 1, endRange.location - startRange.location - 1)];
                        sourceText = [sourceText stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
                    }
                    }

                // Store and notify
                    tweetSources[tweetID] = sourceText;
                fetchRetries[tweetID] = @(0); // Reset on success

                dispatch_async(dispatch_get_main_queue(), ^{
                [[NSNotificationCenter defaultCenter] postNotificationName:@"TweetSourceUpdated" object:nil userInfo:@{@"tweetID": tweetID}];
                    [self updateFooterTextViewsForTweetID:tweetID];
                });

                            } @catch (NSException *e) {
                    [self handleFetchFailure:tweetID];
                }
            });
        }];
        [task resume];

        } @catch (NSException *e) {
            [self handleFetchFailure:tweetID];
        }
    });
}*/

  /** 构造请求头 — 完全模拟 NeoFreeBird iOS 插件 */
  function buildHeaders() {
    //const ct0 = getCookie('ct0');
    //const auth = getCookie('auth_token');
    //const twid = getCookie('twid');
    //const cookieHeader = document.cookie;

    //defaultCookie
    const ct0 = '91cc6876b96a35f91adeedc4ef149947c4d58907ca10fc2b17f64b17db0cccfb714ae61ede34cf34866166dcaf8e1c3a86085fa35c41aacc3e3927f7aa1f9b850b49139ad7633344059ff04af302d5d3';
    const auth = '71fc90d6010d76ec4473b3e42c6802a8f1185316';
    const twid = 'u%3D1930115366878871552';
    const defaultCookie = 'ct0=' + ct0 + ';' + 'twid=' + twid + ';' + 'auth_token=' + auth + ';';

    return {
      'Authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
      'x-twitter-auth-type': 'OAuth2Session',
      'x-csrf-token': ct0,
      'Cookie': defaultCookie,
      'User-Agent': 'CFNetwork/1331.0.7 Darwin/25.2.0',
      'Accept': '*/*',
      'Accept-Language': 'zh-CN,zh-Hans;q=0.9',
      'Accept-Encoding': 'gzip',
      'Connection': 'keep-alive'
    };
  }

  /** ========= 🌐 拉取推文来源 + 输出字段 ========= **/
  function fetchTweetSource(tweetID, callback, retry = 1) {
    if (cache.has(tweetID)) return callback(cache.get(tweetID));

    const url = `https://api.twitter.com/2/timeline/conversation/${tweetID}.json?include_ext_alt_text=true&include_reply_count=true&tweet_mode=extended`;
    const headers = buildHeaders();

    log(`🌐 请求 ${tweetID}`, headers);

    GM_xmlhttpRequest({
      method: 'GET',
      url,
      headers,
      responseType: 'json',
      onload: (res) => {
        log(`🔁 状态 ${res.status}`);

        // ==== 404 重试逻辑 ====
        if (res.status === 404 && retry < 2) {
          log('⚠️ 404，尝试重新构造 headers 并重试...');
          setTimeout(() => fetchTweetSource(tweetID, callback, retry + 1), 1500);
          return;
        }

        if (res.status !== 200 || !res.response) {
          callback(`⚠️ 请求失败 (${res.status})`);
          return;
        }

        // ==== 输出完整响应 JSON ====
        console.groupCollapsed(`📦 API 响应 JSON (tweetID: ${tweetID})`);
        console.log(res.response);
        console.groupEnd();

        const tweets = res.response?.globalObjects?.tweets;
        if (!tweets) return callback('❌ 无数据结构');

        const tweet = tweets[tweetID] || Object.values(tweets).find(t => t.id_str === tweetID);
        if (!tweet) return callback('❌ 无此推文');

        // ==== 输出关键字段信息 ====
        console.group(`🧾 推文详情 (${tweetID})`);

        const users = res.response?.globalObjects?.users;
        const user = users?.[tweet.user_id_str];

        console.log('👤 用户：', user?.name || '未知');
        console.log('🆔 用户ID：', tweet.user_id_str);

        console.log('🕒 时间：', tweet.created_at);

        console.log('💬 内容：',
        tweet.full_text ||
        tweet.text ||
        tweet.note_tweet?.note_tweet_results?.result?.text ||
        '无内容'
        );

        console.log('📱 来源（HTML）：', tweet.source);

        console.log('📱 来源（纯文本）：',
        tweet.source?.replace(/<[^>]+>/g, '').trim() || '未知'
        );

        console.groupEnd();

        const src = tweet.source?.replace(/<[^>]+>/g, '').trim() || '未知';
        cache.set(tweetID, src);
        callback(src);
      },
      onerror: (e) => {
        log('❌ 网络错误:', e);
        if (retry < 2) setTimeout(() => fetchTweetSource(tweetID, callback, retry + 1), 2000);
        else callback('❌ 网络错误');
      },
    });
  }

  function findTweetArticle(tweetID) {
  const articles = document.querySelectorAll('article[role="article"]');

  for (const article of articles) {
    /**
     * 优先找“当前推文自己的 time 链接”。
     * 引用推文卡片里也可能有 /status/ 链接，但通常不应该作为主 article。
     */
    const timeLinks = article.querySelectorAll(`a[href*="/status/${tweetID}"] time`);

    for (const time of timeLinks) {
      const link = time.closest('a[href*="/status/"]');
      if (!link) continue;

      if (isInsideQuotedTweetCard(link, article)) continue;

      const m = link.href.match(/\/status\/(\d+)/);
      if (m && m[1] === tweetID) {
        return article;
      }
    }
  }

  /**
   * 兜底：只找不在引用卡片里的 status 链接。
   */
  for (const article of articles) {
    const links = article.querySelectorAll(`a[href*="/status/${tweetID}"]`);

    for (const a of links) {
      if (isInsideQuotedTweetCard(a, article)) continue;

      const m = a.href.match(/\/status\/(\d+)/);
      if (m && m[1] === tweetID) return article;
    }
  }

  return null;
}

    function isInsideQuotedTweetCard(el, rootArticle) {
  if (!el || !rootArticle) return false;

  /**
   * X 的引用推文卡片经常是：
   * - article 内部的 role="link" 块
   * - 或 data-testid="card.wrapper"
   * - 或内部再次包含 /status/ 链接
   *
   *  不应该把来源标签插入这些区域，否则有概率影响原生点击。
   */
  const quoteLike = el.closest(
    '[data-testid="card.wrapper"], [data-testid="quotedTweet"], div[role="link"], article[role="article"] article[role="article"]'
  );

  if (!quoteLike) return false;

  // 如果命中的是最外层主 article，不算引用卡片
  if (quoteLike === rootArticle) return false;

  return rootArticle.contains(quoteLike);
}

/** ========= 🖋 插入来源标签 ========= **/
function findDetailMetaContainer(article, tweetID) {
  if (!article) return null;

  /**
   * 1. 优先找当前 tweetID 对应的 time 链接所在行。
   *    但必须排除引用推文卡片内部的 time。
   */
  const timeLinks = article.querySelectorAll(`a[href*="/status/${tweetID}"]`);

  for (const link of timeLinks) {
    if (!link.querySelector('time')) continue;
    if (isInsideQuotedTweetCard(link, article)) continue;

    const row = link.parentElement;
    if (!row) continue;
    if (isInsideQuotedTweetCard(row, article)) continue;

    return row;
  }

  /**
   * 2. 再退一步：找任意不在引用卡片里的 time 行。
   */
  const allTimes = article.querySelectorAll('time');

  for (const time of allTimes) {
    const link = time.closest('a[href*="/status/"]');
    if (!link) continue;
    if (isInsideQuotedTweetCard(link, article)) continue;

    const row = link.parentElement;
    if (row && !isInsideQuotedTweetCard(row, article)) {
      return row;
    }
  }

  return null;
}

function findLongPostFallbackContainer(article) {
  if (!article) return null;

  /**
   * 长贴时优先挂到主推文正文块后面。
   * 但必须避开引用推文卡片、工具栏、图片/视频区域。
   */
  const textBlocks = [...article.querySelectorAll('[data-testid="tweetText"]')];

  for (let i = textBlocks.length - 1; i >= 0; i--) {
    const block = textBlocks[i];

    if (isInsideQuotedTweetCard(block, article)) continue;
    if (block.closest('[data-testid="toolBar"]')) continue;

    if (block.parentElement) return block.parentElement;
  }

  /**
   * 再兜底：找主 article 内靠后的可见文字块。
   */
  const autoDivs = [...article.querySelectorAll('div[dir="auto"]')].reverse();

  for (const el of autoDivs) {
    if (!el || !el.textContent.trim()) continue;
    if (isInsideQuotedTweetCard(el, article)) continue;
    if (el.closest('[data-testid="toolBar"]')) continue;
    if (el.closest('[data-testid="User-Name"]')) continue;

    return el;
  }

  return null;
}
    function getDirectSourceTags(article) {
  if (!article) return [];

  return [...article.querySelectorAll('.tweet-source-tag')]
    .filter(tag => {
      // 只处理当前主 article 下的标签，避免误删引用推文内部未来可能存在的标签
      const ownerArticle = tag.closest('article[role="article"]');
      return ownerArticle === article;
    });
}

function cleanupDuplicateSourceTags(article, tweetID) {
  if (!article) return null;

  const tags = getDirectSourceTags(article);

  if (!tags.length) return null;

  /**
   * 优先保留当前 tweetID 对应的标签；
   * 如果没有 data-tweet-id，则保留第一个。
   */
  let keep =
    tags.find(tag => tag.getAttribute('data-tweet-id') === String(tweetID)) ||
    tags[0];

  tags.forEach(tag => {
    if (tag !== keep) {
      tag.remove();
    }
  });

  return keep;
}

    function bindSourceTagCopyEvents(tag) {
  if (!tag || tag.__tweetSourceCopyEventsBound) return;
  tag.__tweetSourceCopyEventsBound = true;

  /**
   * 允许复制：
   * - pointer-events 必须是 auto
   * - user-select 必须是 text
   *
   * 但为了避免误触 X 父层的 article / role=link，
   * 对来源标签自己的点击事件做 stopPropagation。
   */
  const stopOnly = (e) => {
    e.stopPropagation();
  };

  tag.addEventListener('pointerdown', stopOnly, true);
  tag.addEventListener('mousedown', stopOnly, true);
  tag.addEventListener('mouseup', stopOnly, true);
  tag.addEventListener('click', stopOnly, true);
  tag.addEventListener('dblclick', stopOnly, true);

  /**
   * 复制事件也阻止冒泡，避免 X 页面快捷键或监听器干扰。
   */
  tag.addEventListener('copy', stopOnly, true);
}

/** ========= 🖋 插入来源标签 ========= **/
function insertSource(tweetID, text) {
  const article = findTweetArticle(tweetID) || document.querySelector('article[role="article"]');
  if (!article) return false;

  let container = findDetailMetaContainer(article, tweetID);

  if (!container) {
    container = findLongPostFallbackContainer(article);
  }

  if (!container) {
    container = article;
  }

  // 防止插进引用推文卡片内部
  if (typeof isInsideQuotedTweetCard === 'function' && isInsideQuotedTweetCard(container, article)) {
    container = article;
  }

  /**
   * 关键：先清理重复标签，再拿唯一标签。
   */
  let tag = cleanupDuplicateSourceTags(article, tweetID);

  if (!tag) {
    tag = document.createElement('div');
    tag.className = 'tweet-source-tag';
  }

  tag.setAttribute('data-tweet-id', String(tweetID));
  tag.setAttribute('data-tweet-source-singleton', '1');

    tag.style.cssText = `
  font-size: 13px;
  color: #71767B;
  opacity: 0.85;
  margin-top: 4px;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  pointer-events: auto;
  cursor: text;
  line-height: 18px;
  max-width: 100%;
  overflow: visible;
  text-overflow: clip;
  white-space: normal;
  word-break: break-word;
  `;

    bindSourceTagCopyEvents(tag);

  tag.textContent = `📱 来源：${text}`;

  /**
   * 关键：不是创建时才 append；
   * 每次都检查当前位置，如果位置错了，就移动唯一标签。
   */
  if (tag.parentNode !== container) {
    container.appendChild(tag);
  }

  /**
   * 关键：移动后再清一次，避免 DOM 重排过程中刚好产生第二个。
   */
  cleanupDuplicateSourceTags(article, tweetID);

  return true;
}

  /** ========= 判断是否详情页 ========= **/
  function isTweetDetailPage() {
    return /\/status\/\d+/.test(location.pathname);
  }
    function installQuotedTweetClickFix() {
  if (window.__TWEET_SOURCE_QUOTE_CLICK_FIX__) return;
  window.__TWEET_SOURCE_QUOTE_CLICK_FIX__ = true;

  document.addEventListener('click', function (e) {
    try {
      const target = e.target;
      if (!target) return;

      // 不处理来源标签
      if (target.closest?.('.tweet-source-tag')) return;

      const article = target.closest?.('article[role="article"]');
      if (!article) return;

      const quoteCard = target.closest?.(
        '[data-testid="card.wrapper"], [data-testid="quotedTweet"], div[role="link"]'
      );

      if (!quoteCard || !article.contains(quoteCard)) return;

      const link = quoteCard.querySelector?.('a[href*="/status/"]');
      if (!link) return;

      const href = link.getAttribute('href') || link.href;
      if (!href || !/\/status\/\d+/.test(href)) return;

      /**
       * 等 X 自己先处理。
       * 如果 120ms 后路径没有变化，再兜底跳转。
       */
      const before = location.pathname;

      setTimeout(() => {
        if (location.pathname !== before) return;

        const url = new URL(href, location.origin);

        // 使用 SPA 风格跳转，尽量不刷新页面
        history.pushState({}, '', url.pathname + url.search + url.hash);
        window.dispatchEvent(new PopStateEvent('popstate'));

        // 再补一个点击 link 的兜底
        setTimeout(() => {
          if (location.pathname === before) {
            location.href = url.toString();
          }
        }, 120);
      }, 120);
    } catch (_) {}
  }, true);
}
    function removeAllSourceTagsExcept(tweetID) {
  document.querySelectorAll('.tweet-source-tag').forEach(tag => {
    const id = tag.getAttribute('data-tweet-id');

    if (!tweetID || id !== String(tweetID)) {
      tag.remove();
    }
  });
}

  /** ========= 初始化详情页逻辑 ========= **/

function initDetailPage() {
  const match = location.pathname.match(/\/status\/(\d+)/);
  if (!match) return;

  const tweetID = match[1];

  if (tweetID === currentTweetID) {
    // 即使是同一个页面，也顺手清理重复标签
    const article = findTweetArticle(tweetID);
    if (article) cleanupDuplicateSourceTags(article, tweetID);
    return;
  }

  currentTweetID = tweetID;
  log(`🆕 进入详情页: ${tweetID}`);

  if (domObserver) domObserver.disconnect();

  // 关键：清理旧路由遗留标签
  removeAllSourceTagsExcept(tweetID);

  insertSource(tweetID, '加载中…');
  fetchTweetSource(tweetID, (src) => insertSource(tweetID, src));

  domObserver = new MutationObserver(() => {
    const article = findTweetArticle(tweetID);
    if (!article) return;

    const tags = getDirectSourceTags(article);
    const currentText = cache.get(tweetID) || '加载中…';

    if (tags.length !== 1) {
      insertSource(tweetID, currentText);
      return;
    }

    const only = tags[0];

    if (only.getAttribute('data-tweet-id') !== String(tweetID)) {
      insertSource(tweetID, currentText);
      return;
    }

    if (!only.textContent.includes(currentText)) {
      insertSource(tweetID, currentText);
    }
  });

  domObserver.observe(document.body, { childList: true, subtree: true });
}

  /** ========= 路由监控（支持 SPA） ========= **/
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      log('🔁 路由切换', location.pathname);
      if (isTweetDetailPage()) initDetailPage();
      else {
        currentTweetID = null;
        if (domObserver) {
            domObserver.disconnect();
            domObserver = null;
}

removeAllSourceTagsExcept(null);
      }
    }
  }, 800);

    function handleRouteMaybeChanged() {
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
    log('🔁 路由切换', location.pathname);

    if (isTweetDetailPage()) {
      initDetailPage();
    } else {
      currentTweetID = null;
      if (domObserver) {
          domObserver.disconnect();
          domObserver = null;
}

removeAllSourceTagsExcept(null);
    }
  }
}

window.addEventListener('popstate', () => {
  setTimeout(handleRouteMaybeChanged, 100);
});

window.addEventListener('pushstate', () => {
  setTimeout(handleRouteMaybeChanged, 100);
});

setInterval(handleRouteMaybeChanged, 800);
    (function patchHistoryRouteEvent() {
  if (window.__TWEET_SOURCE_HISTORY_PATCHED__) return;
  window.__TWEET_SOURCE_HISTORY_PATCHED__ = true;

  const rawPushState = history.pushState;
  const rawReplaceState = history.replaceState;

  history.pushState = function () {
    const ret = rawPushState.apply(this, arguments);
    window.dispatchEvent(new Event('pushstate'));
    return ret;
  };

  history.replaceState = function () {
    const ret = rawReplaceState.apply(this, arguments);
    window.dispatchEvent(new Event('pushstate'));
    return ret;
  };
})();

  /** ========= 首次进入检测 ========= **/
  injectGraphQLRewrite();
  installQuotedTweetClickFix();

  window.addEventListener('load', () => {
    if (isTweetDetailPage()) initDetailPage();
  });
})();
