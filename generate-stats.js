#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const Parser = require("rss-parser");

const LANGUAGE_COLORS = {
  JavaScript: "#f1e05a",
  TypeScript: "#3178c6",
  Python: "#3572A5",
  Java: "#b07219",
  "C++": "#f34b7d",
  C: "#555555",
  "C#": "#239120",
  Go: "#00ADD8",
  Rust: "#dea584",
  Ruby: "#701516",
  PHP: "#4F5D95",
  Swift: "#F05138",
  Kotlin: "#A97BFF",
  Dart: "#00B4AB",
  Scala: "#c22d40",
  HTML: "#e34c26",
  CSS: "#563d7c",
  SCSS: "#c6538c",
  Shell: "#89e051",
  Vue: "#41b883",
  Svelte: "#ff3e00",
  Lua: "#000080",
  Perl: "#394579",
  R: "#198CE7",
  MATLAB: "#e16737",
  Dockerfile: "#384d54",
  Makefile: "#427819",
  Haskell: "#5e5086",
  Elixir: "#6e4a7e",
  "Jupyter Notebook": "#DA5B0B",
  PowerShell: "#012456",
  Default: "#555555",
};

const CACHE_FILE = path.join(__dirname, "language-colors-cache.json");
const STATS_CACHE_FILE = path.join(__dirname, "stats-cache.json");
const STATS_CACHE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

let cachedLanguageColors = null;

async function loadLanguageColors() {
  if (cachedLanguageColors) return cachedLanguageColors;

  if (fs.existsSync(CACHE_FILE)) {
    try {
      const cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
      const oneDay = 24 * 60 * 60 * 1000;
      if (Date.now() - cache.timestamp < oneDay) {
        console.log("Using cached language colors (< 1 day old)");
        cachedLanguageColors = cache.colors;
        return cachedLanguageColors;
      }
    } catch (e) {
      /* cache read failed, continue */
    }
  }

  console.log("Fetching language colors from GitHub Linguist...");
  try {
    const response = await fetch(
      "https://raw.githubusercontent.com/github/linguist/master/lib/linguist/languages.yml",
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const languages = yaml.load(await response.text());
    const colors = {};
    for (const [name, config] of Object.entries(languages)) {
      if (config.color) colors[name] = config.color;
    }

    cachedLanguageColors = colors;
    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify({ timestamp: Date.now(), colors }, null, 2),
    );
    console.log(`Loaded ${Object.keys(colors).length} language colors`);
    return colors;
  } catch (e) {
    console.error(
      `Failed to fetch language colors: ${e.message}, using defaults`,
    );
    return LANGUAGE_COLORS;
  }
}

async function loadStatsCache(repoSlug) {
  const sources = [];
  if (repoSlug) {
    sources.push({
      type: "remote",
      url: `https://raw.githubusercontent.com/${repoSlug}/main/stats-cache.json`,
    });
  }
  sources.push({ type: "local", filePath: STATS_CACHE_FILE });

  for (const source of sources) {
    try {
      if (source.type === "remote") {
        const response = await fetch(source.url);
        if (!response.ok) continue;
        return { cache: await response.json(), source: source.url };
      }
      if (fs.existsSync(source.filePath)) {
        return {
          cache: JSON.parse(fs.readFileSync(source.filePath, "utf-8")),
          source: source.filePath,
        };
      }
    } catch (e) {
      continue;
    }
  }
  return { cache: null, source: null };
}

function isStatsCacheFresh(cache, lastYear) {
  if (!cache || !cache.timestamp || !cache.throughYear) return false;
  if (cache.throughYear !== lastYear) return false;
  return Date.now() - cache.timestamp <= STATS_CACHE_MAX_AGE;
}

function getLanguageColor(name, githubColor, languageColors) {
  return (
    githubColor ||
    languageColors[name] ||
    LANGUAGE_COLORS[name] ||
    LANGUAGE_COLORS.Default
  );
}

function formatNumber(num) {
  return num.toLocaleString();
}

async function getGitHubToken() {
  if (process.env.USER_API_TOKEN) return process.env.USER_API_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

  try {
    const { execSync } = require("child_process");
    const token = execSync("gh auth token", { encoding: "utf-8" }).trim();
    if (token) return token;
  } catch (e) {
    /* gh CLI not available */
  }

  throw new Error(
    "No GitHub token found. Set GITHUB_TOKEN or USER_API_TOKEN env var, or use `gh auth login`",
  );
}

// GraphQL Helpers
function isTransientError(errors) {
  return errors.some((e) => {
    const msg = String(e.message || "");
    const type = String(e.type || "");
    return msg.includes("Something went wrong") || type === "INTERNAL";
  });
}

async function graphqlQuery(token, query, variables = {}) {
  const maxAttempts = 7;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "readme-stats-generator",
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) {
        if (attempt < maxAttempts) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 20000);
          console.log(
            `  Attempt ${attempt}/${maxAttempts} failed (HTTP ${response.status}), retrying in ${Math.ceil(delay / 1000)}s...`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw new Error(`GraphQL HTTP ${response.status}`);
      }

      const data = await response.json();
      if (data.errors) {
        if (isTransientError(data.errors) && attempt < maxAttempts) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 20000);
          console.log(
            `  Attempt ${attempt}/${maxAttempts} failed (transient), retrying in ${Math.ceil(delay / 1000)}s...`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw new Error(`GraphQL Error: ${JSON.stringify(data.errors)}`);
      }

      return data.data;
    } catch (err) {
      if (attempt < maxAttempts) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 20000);
        console.log(
          `  Attempt ${attempt}/${maxAttempts} error, retrying in ${Math.ceil(delay / 1000)}s...`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

async function fetchUserInfo(token, fromDate, toDate) {
  const query = `
    query {
      viewer {
        id
        login
        createdAt
        repositories(ownerAffiliations: OWNER, privacy: PUBLIC, first: 100) {
          totalCount
          nodes {
            name
            languages(first: 10) {
              edges {
                size
                node { name, color }
              }
            }
          }
        }
        contributionsCollection {
          contributionYears
        }
        lastYear: contributionsCollection(from: "${fromDate}", to: "${toDate}") {
          totalCommitContributions
          totalIssueContributions
          totalPullRequestContributions
        }
      }
    }
  `;
  return graphqlQuery(token, query);
}

async function fetchAllTimeContributions(token, years) {
  let totalCommits = 0,
    totalIssues = 0,
    totalPRs = 0;
  const yearly = {};

  for (const year of years) {
    const from = `${year}-01-01T00:00:00Z`;
    const to = `${year}-12-31T23:59:59Z`;
    const query = `
      query {
        viewer {
          contributionsCollection(from: "${from}", to: "${to}") {
            totalCommitContributions
            totalIssueContributions
            totalPullRequestContributions
          }
        }
      }
    `;
    const data = await graphqlQuery(token, query);
    const cc = data.viewer.contributionsCollection;
    totalCommits += cc.totalCommitContributions;
    totalIssues += cc.totalIssueContributions;
    totalPRs += cc.totalPullRequestContributions;
    yearly[year] = {
      commits: cc.totalCommitContributions,
      issues: cc.totalIssueContributions,
      prs: cc.totalPullRequestContributions,
    };
    console.log(
      `  ${year}: ${cc.totalCommitContributions} commits, ${cc.totalIssueContributions} issues, ${cc.totalPullRequestContributions} PRs`,
    );
  }

  return { totalCommits, totalIssues, totalPRs, yearly };
}

async function fetchTotalStars(token) {
  let totalStars = 0;
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const query = `
      query($cursor: String) {
        viewer {
          repositories(first: 100, after: $cursor, ownerAffiliations: OWNER, privacy: PUBLIC) {
            pageInfo { hasNextPage, endCursor }
            nodes { stargazerCount }
          }
        }
      }
    `;
    const data = await graphqlQuery(token, query, { cursor });
    const page = data.viewer.repositories;
    totalStars += page.nodes.reduce((sum, r) => sum + r.stargazerCount, 0);
    hasNextPage = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }

  return totalStars;
}

async function fetchUserReposWithCommits(
  token,
  username,
  userId,
  since,
  languageColors,
) {
  const repos = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const query = `
      query($username: String!, $cursor: String) {
        user(login: $username) {
          repositories(first: 30, after: $cursor, ownerAffiliations: OWNER, privacy: PUBLIC) {
            pageInfo { hasNextPage, endCursor }
            nodes {
              name
              url
              defaultBranchRef {
                target {
                  ... on Commit {
                    history(since: "${since.toISOString()}", author: {id: "${userId}"}) {
                      totalCount
                    }
                  }
                }
              }
              languages(first: 10) {
                edges {
                  size
                  node { name, color }
                }
              }
            }
          }
        }
      }
    `;

    let data;
    try {
      data = await graphqlQuery(token, query, { username, cursor });
    } catch (err) {
      if (/GraphQL HTTP 50[234]/.test(String(err.message))) {
        console.log("  Gateway error fetching repos, using partial list.");
        break;
      }
      throw err;
    }

    const repoNodes = data.user.repositories.nodes;
    for (const repo of repoNodes) {
      const commitCount =
        repo.defaultBranchRef?.target?.history?.totalCount || 0;
      if (commitCount > 0) {
        const totalLangSize = repo.languages.edges.reduce(
          (sum, e) => sum + e.size,
          0,
        );
        const languages = repo.languages.edges.map((e) => ({
          name: e.node.name,
          percentage: totalLangSize > 0 ? (e.size / totalLangSize) * 100 : 0,
          color: getLanguageColor(e.node.name, e.node.color, languageColors),
        }));
        repos.push({
          name: repo.name,
          url: repo.url,
          commits: commitCount,
          languages,
          additions: 0,
          deletions: 0,
        });
      }
    }

    hasNextPage = data.user.repositories.pageInfo.hasNextPage;
    cursor = data.user.repositories.pageInfo.endCursor;
    console.log(`  Fetched ${repos.length} repos with commits...`);
  }

  return repos;
}

async function fetchRepoCommitStats(token, owner, repoName, userId, since) {
  let additions = 0,
    deletions = 0;
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const query = `
      query($owner: String!, $repoName: String!, $cursor: String) {
        repository(owner: $owner, name: $repoName) {
          defaultBranchRef {
            target {
              ... on Commit {
                history(first: 100, after: $cursor, since: "${since.toISOString()}", author: {id: "${userId}"}) {
                  pageInfo { hasNextPage, endCursor }
                  nodes { additions, deletions }
                }
              }
            }
          }
        }
      }
    `;

    let data;
    try {
      data = await graphqlQuery(token, query, { owner, repoName, cursor });
    } catch (err) {
      if (/GraphQL HTTP 50[234]/.test(String(err.message))) {
        console.log(`    Gateway error for ${repoName}, skipping line stats.`);
        break;
      }
      throw err;
    }

    const history = data.repository?.defaultBranchRef?.target?.history;
    if (!history) break;

    for (const commit of history.nodes) {
      additions += commit.additions || 0;
      deletions += commit.deletions || 0;
    }

    hasNextPage = history.pageInfo.hasNextPage;
    cursor = history.pageInfo.endCursor;
  }

  return { additions, deletions };
}

async function fetchRecentRepos(token, username, count = 8) {
  const query = `
    query($username: String!) {
      user(login: $username) {
        repositories(
          first: ${count},
          ownerAffiliations: OWNER,
          privacy: PUBLIC,
          orderBy: { field: PUSHED_AT, direction: DESC }
        ) {
          nodes {
            name
            url
            description
            pushedAt
            stargazerCount
            primaryLanguage {
              name
              color
            }
          }
        }
      }
    }
  `;

  const data = await graphqlQuery(token, query, { username });
  return data.user.repositories.nodes.map((repo) => ({
    name: repo.name,
    url: repo.url,
    description: repo.description || "No description",
    language: repo.primaryLanguage?.name || "—",
    stars: repo.stargazerCount,
    updatedAt: formatRelativeDate(new Date(repo.pushedAt)),
  }));
}

async function fetchBlogPosts(count = 5) {
  try {
    const parser = new Parser();
    const feed = await parser.parseURL("https://divyanshusoni.com/rss.xml");
    return feed.items.slice(0, count).map((item) => ({
      title: item.title,
      url: item.link,
    }));
  } catch (e) {
    console.log("  Could not fetch blog posts from RSS feed");
    return [];
  }
}

function formatRelativeDate(date) {
  const now = new Date();
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30)
    return `${Math.floor(diffDays / 7)} week${Math.floor(diffDays / 7) > 1 ? "s" : ""} ago`;
  if (diffDays < 365)
    return `${Math.floor(diffDays / 30)} month${Math.floor(diffDays / 30) > 1 ? "s" : ""} ago`;
  return `${Math.floor(diffDays / 365)} year${Math.floor(diffDays / 365) > 1 ? "s" : ""} ago`;
}

function calculateTopLanguages(repos, topN = 5, languageColors) {
  const languageCommits = {};

  for (const repo of repos) {
    for (const lang of repo.languages) {
      if (!languageCommits[lang.name]) {
        languageCommits[lang.name] = {
          name: lang.name,
          weightedCommits: 0,
          color: lang.color,
        };
      }
      languageCommits[lang.name].weightedCommits +=
        repo.commits * (lang.percentage / 100);
    }
  }

  const sorted = Object.values(languageCommits)
    .sort((a, b) => b.weightedCommits - a.weightedCommits)
    .slice(0, topN);

  const total = sorted.reduce((sum, l) => sum + l.weightedCommits, 0);

  return sorted.map((lang) => ({
    name: lang.name,
    percentage:
      total > 0 ? Math.round((lang.weightedCommits / total) * 100) : 0,
    color: getLanguageColor(lang.name, lang.color, languageColors),
  }));
}

function generateLanguageBadge(lang) {
  const color = encodeURIComponent(lang.color);
  const message = encodeURIComponent(`${lang.name} ${lang.percentage}%`);
  return `![${lang.name}](https://img.shields.io/static/v1?style=flat-square&label=%E2%A0%80&color=555&labelColor=${color}&message=${message})`;
}

function processTemplate(template, data) {
  let result = template;

  // Simple placeholder replacements
  result = result.replace(/\{\{\s*USERNAME\s*\}\}/g, data.username);
  result = result.replace(/\{\{\s*ACCOUNT_AGE\s*\}\}/g, data.accountAge);
  result = result.replace(
    /\{\{\s*COMMITS\s*\}\}/g,
    formatNumber(data.totalCommitsLastYear),
  );
  result = result.replace(
    /\{\{\s*TOTAL_COMMITS_LAST_YEAR\s*\}\}/g,
    formatNumber(data.totalCommitsLastYear),
  );
  result = result.replace(
    /\{\{\s*TOTAL_COMMITS_ALL_TIME\s*\}\}/g,
    typeof data.totalCommitsAllTime === "number"
      ? formatNumber(data.totalCommitsAllTime)
      : data.totalCommitsAllTime,
  );
  result = result.replace(
    /\{\{\s*REPOS_OWNED\s*\}\}/g,
    formatNumber(data.reposOwned),
  );
  result = result.replace(
    /\{\{\s*REPOS_OWNED_ALL_TIME\s*\}\}/g,
    formatNumber(data.reposOwned),
  );
  result = result.replace(
    /\{\{\s*STARS_RECEIVED\s*\}\}/g,
    formatNumber(data.starsReceived),
  );
  result = result.replace(
    /\{\{\s*STARS_ALL_TIME\s*\}\}/g,
    formatNumber(data.starsReceived),
  );
  result = result.replace(
    /\{\{\s*TOTAL_ADDITIONS_LAST_YEAR\s*\}\}/g,
    `**+${formatNumber(data.totalAdditionsLastYear)}**`,
  );
  result = result.replace(
    /\{\{\s*TOTAL_DELETIONS_LAST_YEAR\s*\}\}/g,
    `**-${formatNumber(data.totalDeletionsLastYear)}**`,
  );
  result = result.replace(
    /\{\{\s*TOTAL_ISSUES_ALL_TIME\s*\}\}/g,
    formatNumber(data.totalIssuesAllTime),
  );
  result = result.replace(
    /\{\{\s*TOTAL_PRS_ALL_TIME\s*\}\}/g,
    formatNumber(data.totalPRsAllTime),
  );
  result = result.replace(
    /\{\{\s*TOTAL_ISSUES_LAST_YEAR\s*\}\}/g,
    formatNumber(data.totalIssuesLastYear),
  );
  result = result.replace(
    /\{\{\s*TOTAL_PRS_LAST_YEAR\s*\}\}/g,
    formatNumber(data.totalPRsLastYear),
  );
  result = result.replace(
    /\{\{\s*TOP_LANGUAGES_ROWS\s*\}\}/g,
    data.topLanguagesRows,
  );

  // Language template block
  const langMatch = result.match(
    /\{\{\s*LANGUAGE_TEMPLATE_START\s*\}\}([\s\S]*?)\{\{\s*LANGUAGE_TEMPLATE_END\s*\}\}/,
  );
  if (langMatch) {
    const langTemplate = langMatch[1].trim();
    const langBadges = data.topLanguages
      .map((lang) => {
        let badge = langTemplate;
        badge = badge.replace(/\{\{\s*LANG_NAME\s*\}\}/g, lang.name);
        badge = badge.replace(/\{\{\s*LANG_PERCENT\s*\}\}/g, lang.percentage);
        badge = badge.replace(/\{\{\s*LANG_COLOR\s*\}\}/g, lang.color);
        badge = badge.replace(
          /\{\{\s*LANG_BADGE\s*\}\}/g,
          generateLanguageBadge(lang),
        );
        return badge;
      })
      .join(" ");
    result = result.replace(
      /\{\{\s*LANGUAGE_TEMPLATE_START\s*\}\}[\s\S]*?\{\{\s*LANGUAGE_TEMPLATE_END\s*\}\}/,
      langBadges,
    );
  }

  // Repo template block (most active projects)
  const repoMatch = result.match(
    /\{\{\s*REPO_TEMPLATE_START\s*\}\}([\s\S]*?)\{\{\s*REPO_TEMPLATE_END\s*\}\}/,
  );
  if (repoMatch) {
    const repoTemplate = repoMatch[1].trim();
    const repoItems = data.topRepos
      .map((repo) => {
        let item = repoTemplate;
        item = item.replace(/\{\{\s*REPO_NAME\s*\}\}/g, repo.name);
        item = item.replace(/\{\{\s*REPO_URL\s*\}\}/g, repo.url);
        item = item.replace(
          /\{\{\s*REPO_COMMITS\s*\}\}/g,
          formatNumber(repo.commits),
        );
        item = item.replace(
          /\{\{\s*REPO_ADDITIONS\s*\}\}/g,
          `$\\color{Green}{\\textsf{+${formatNumber(repo.additions)}}}$`,
        );
        item = item.replace(
          /\{\{\s*REPO_DELETIONS\s*\}\}/g,
          `$\\color{Red}{\\textsf{-${formatNumber(repo.deletions)}}}$`,
        );
        return item.trimEnd();
      })
      .join("\n");
    result = result.replace(
      /\{\{\s*REPO_TEMPLATE_START\s*\}\}[\s\S]*?\{\{\s*REPO_TEMPLATE_END\s*\}\}/,
      repoItems,
    );
  }

  // Recent repos template block (projects in progress)
  const recentMatch = result.match(
    /\{\{\s*RECENT_REPOS_START\s*\}\}([\s\S]*?)\{\{\s*RECENT_REPOS_END\s*\}\}/,
  );
  if (recentMatch) {
    const recentTemplate = recentMatch[1].trim();
    const recentItems = data.recentRepos
      .map((repo) => {
        let item = recentTemplate;
        item = item.replace(/\{\{\s*RECENT_REPO_NAME\s*\}\}/g, repo.name);
        item = item.replace(/\{\{\s*RECENT_REPO_URL\s*\}\}/g, repo.url);
        item = item.replace(
          /\{\{\s*RECENT_REPO_DESCRIPTION\s*\}\}/g,
          repo.description,
        );
        item = item.replace(
          /\{\{\s*RECENT_REPO_LANGUAGE\s*\}\}/g,
          repo.language,
        );
        item = item.replace(/\{\{\s*RECENT_REPO_STARS\s*\}\}/g, repo.stars);
        item = item.replace(
          /\{\{\s*RECENT_REPO_UPDATED\s*\}\}/g,
          repo.updatedAt,
        );
        return item.trimEnd();
      })
      .join("\n");
    result = result.replace(
      /\{\{\s*RECENT_REPOS_START\s*\}\}[\s\S]*?\{\{\s*RECENT_REPOS_END\s*\}\}/,
      recentItems,
    );
  }

  // Blog posts
  if (data.blogPosts && data.blogPosts.length > 0) {
    const blogLines = data.blogPosts
      .map((post) => `* [${post.title}](${post.url})`)
      .join("\n");
    result = result.replace(/\{\{\s*BLOG_POSTS\s*\}\}/g, blogLines);
  } else {
    result = result.replace(/\{\{\s*BLOG_POSTS\s*\}\}/g, "");
  }

  return result;
}

async function main() {
  console.log("--Starting stats generation--\n");

  const languageColors = await loadLanguageColors();
  const token = await getGitHubToken();
  console.log("GitHub token obtained\n");

  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const fromDate = oneYearAgo.toISOString();
  const toDate = new Date().toISOString();

  console.log("Fetching user info");
  const userInfo = await fetchUserInfo(token, fromDate, toDate);
  const viewer = userInfo.viewer;
  console.log(`   User: ${viewer.login}\n`);

  const accountAge = Math.floor(
    (new Date() - new Date(viewer.createdAt)) / (365.25 * 24 * 60 * 60 * 1000),
  );

  // All-time contributions (with caching)
  const years = viewer.contributionsCollection.contributionYears;
  const lastYear = new Date().getFullYear() - 1;
  const cacheYear = Math.min(lastYear, 2025);
  const repoSlug = process.env.GITHUB_REPOSITORY;
  const { cache: statsCache, source: statsCacheSource } =
    await loadStatsCache(repoSlug);
  const cacheFresh = isStatsCacheFresh(statsCache, cacheYear);
  let cachedTotals = null,
    cachedYears = null;

  if (cacheFresh) {
    cachedTotals = statsCache.totals;
    cachedYears = statsCache.yearly;
    console.log(`Using cached stats from ${statsCacheSource}`);
  }

  const yearsToFetch = cacheFresh ? years.filter((y) => y > cacheYear) : years;
  console.log(
    `Fetching contributions for years: ${yearsToFetch.join(", ") || "(none — all cached)"}`,
  );

  const allTime =
    yearsToFetch.length > 0
      ? await fetchAllTimeContributions(token, yearsToFetch)
      : { totalCommits: 0, totalIssues: 0, totalPRs: 0, yearly: {} };

  const totalCommitsAllTime =
    (cachedTotals?.commits || 0) + allTime.totalCommits;
  const totalIssuesAllTime = (cachedTotals?.issues || 0) + allTime.totalIssues;
  const totalPRsAllTime = (cachedTotals?.prs || 0) + allTime.totalPRs;
  const mergedYearly = { ...(cachedYears || {}), ...(allTime.yearly || {}) };

  const totalCommitsLastYear = viewer.lastYear.totalCommitContributions;
  const totalIssuesLastYear = viewer.lastYear.totalIssueContributions;
  const totalPRsLastYear = viewer.lastYear.totalPullRequestContributions;

  // Update cache if needed
  if (!cacheFresh) {
    const cachePayload = {
      timestamp: Date.now(),
      throughYear: cacheYear,
      totals: {
        commits: totalCommitsAllTime,
        issues: totalIssuesAllTime,
        prs: totalPRsAllTime,
      },
      yearly: Object.fromEntries(
        Object.entries(mergedYearly).filter(
          ([year]) => Number(year) <= cacheYear,
        ),
      ),
    };
    fs.writeFileSync(STATS_CACHE_FILE, JSON.stringify(cachePayload, null, 2));
    console.log(`💾 Stats cache updated`);
  }

  console.log(
    `\nAll time — Commits: ${totalCommitsAllTime}, Issues: ${totalIssuesAllTime}, PRs: ${totalPRsAllTime}`,
  );
  console.log(
    `Last year — Commits: ${totalCommitsLastYear}, Issues: ${totalIssuesLastYear}, PRs: ${totalPRsLastYear}\n`,
  );

  console.log("Fetching repos with commits in last year");
  const reposWithCommits = await fetchUserReposWithCommits(
    token,
    viewer.login,
    viewer.id,
    oneYearAgo,
    languageColors,
  );
  console.log(`   Found ${reposWithCommits.length} repos\n`);

  const topLanguages = calculateTopLanguages(
    reposWithCommits,
    5,
    languageColors,
  );
  console.log(
    `Top languages: ${topLanguages.map((l) => `${l.name} (${l.percentage}%)`).join(", ")}\n`,
  );

  const topRepos = reposWithCommits
    .sort((a, b) => b.commits - a.commits)
    .slice(0, 10);

  console.log("Fetching additions/deletions for top repos");
  let totalAdditionsLastYear = 0,
    totalDeletionsLastYear = 0;

  for (const repo of topRepos) {
    console.log(`   ${repo.name}...`);
    const stats = await fetchRepoCommitStats(
      token,
      viewer.login,
      repo.name,
      viewer.id,
      oneYearAgo,
    );
    repo.additions = stats.additions;
    repo.deletions = stats.deletions;
    totalAdditionsLastYear += stats.additions;
    totalDeletionsLastYear += stats.deletions;
  }

  console.log(
    `   Total: +${totalAdditionsLastYear} / -${totalDeletionsLastYear}\n`,
  );

  const starsReceived = await fetchTotalStars(token);
  console.log(`   Total stars: ${starsReceived}\n`);

  console.log("Fetching recently updated repos");
  const recentRepos = await fetchRecentRepos(token, viewer.login, 8);
  console.log(`   Found ${recentRepos.length} recent repos\n`);

  console.log("Fetching blog posts from divyanshusoni.com");
  const blogPosts = await fetchBlogPosts(5);
  console.log(`   Found ${blogPosts.length} blog posts\n`);

  const statsData = {
    username: viewer.login,
    accountAge,
    totalCommitsLastYear,
    totalCommitsAllTime,
    reposOwned: viewer.repositories.totalCount,
    starsReceived,
    totalAdditionsLastYear,
    totalDeletionsLastYear,
    totalIssuesAllTime,
    totalPRsAllTime,
    totalIssuesLastYear,
    totalPRsLastYear,
    topLanguages,
    topLanguagesRows: (() => {
      const rows = [];
      const allTimeRows = [
        `📦 **${formatNumber(viewer.repositories.totalCount)}** public repos`,
        `🔥 **${formatNumber(totalCommitsAllTime)}** commits`,
        `📋 **${formatNumber(totalIssuesAllTime)}** issues`,
        `🔀 **${formatNumber(totalPRsAllTime)}** PRs`,
        `⭐ **${formatNumber(starsReceived)}** stars`,
      ];
      const lastYearRows = [
        `🔥 **${formatNumber(totalCommitsLastYear)}** commits`,
        `📝 **${formatNumber(totalIssuesLastYear)}** issues`,
        `🔀 **${formatNumber(totalPRsLastYear)}** PRs`,
        `🟢 **+${formatNumber(totalAdditionsLastYear)}** lines added`,
        `🔴 **-${formatNumber(totalDeletionsLastYear)}** lines removed`,
      ];
      for (let i = 0; i < 5; i++) {
        const lang = topLanguages[i];
        const langCell = lang ? generateLanguageBadge(lang) : "";
        rows.push(`| ${allTimeRows[i]} | ${lastYearRows[i]} | ${langCell} |`);
      }
      return rows.join("\n");
    })(),
    topRepos,
    recentRepos,
    blogPosts,
  };

  const templatePath = path.join(__dirname, "TEMPLATE.md");
  let template = "";

  try {
    template = fs.readFileSync(templatePath, "utf-8");
    console.log("Template loaded from TEMPLATE.md");
  } catch (e) {
    console.log(" No TEMPLATE.md found, using default template");
    template = `# Hi there, I'm {{ USERNAME }} 👋\n\n## 📊 Stats\n\n{{ TOP_LANGUAGES_ROWS }}\n\n## 🚀 Top Repositories\n\n{{ REPO_TEMPLATE_START }}\n- [{{ REPO_NAME }}]({{ REPO_URL }}) — {{ REPO_COMMITS }} commits\n{{ REPO_TEMPLATE_END }}\n`;
  }

  const readme = processTemplate(template, statsData);
  const readmePath = path.join(__dirname, "README.md");
  fs.writeFileSync(readmePath, readme);
  console.log(`\n✅ README.md generated successfully!`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
