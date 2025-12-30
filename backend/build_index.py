import json
import os
import re
import time
from datetime import datetime, timezone, timedelta

import requests
import zhipuai


OPINION_API_URL = os.environ.get("OPINION_API_URL", "").strip() or "http://opinion.api.predictscan.dev:10001/api/markets"
OPINION_WRAP_EVENTS_URL = "https://opinionanalytics.xyz/api/markets/wrap-events"
FRONTEND_BASE_URL = "https://app.opinion.trade"
MODEL_NAME = "GLM-4.7"
REF_PARAM = "opinion_hud"
DEBUG = os.environ.get("DEBUG", "").strip().lower() in ("1", "true", "yes", "y", "on")
# When enabled, re-run the LLM for all events from the current API response.
# When disabled (default), reuse previous outputs and only run the LLM for new events
# not present in the previous data.
FULL_AI_REFRESH = os.environ.get("FULL_AI_REFRESH", "0").strip().lower() in ("1", "true", "yes", "y", "on")
# When enabled, skip all LLM calls and use fallback keywords for new events
SKIP_AI = os.environ.get("SKIP_AI", "0").strip().lower() in ("1", "true", "yes", "y", "on")
ZHIPU_TIMEOUT_SECONDS = float(os.environ.get("ZHIPU_TIMEOUT_SECONDS", "30"))
ZHIPU_MAX_RETRIES = int(os.environ.get("ZHIPU_MAX_RETRIES", "2"))


# ============================================================================
# Chinese-English Translation Dictionary for Common Entities
# Used to augment LLM-generated keywords with Chinese translations
# ============================================================================

# Entity translations (for entityGroups)
CN_EN_ENTITY_MAP = {
    # Countries & Regions
    "Russia": ["俄罗斯", "俄国"],
    "Russian": ["俄罗斯", "俄国", "俄"],
    "Ukraine": ["乌克兰"],
    "Ukrainian": ["乌克兰"],
    "China": ["中国"],
    "Chinese": ["中国", "中"],
    "USA": ["美国", "美"],
    "US": ["美国", "美"],
    "United States": ["美国"],
    "America": ["美国", "美"],
    "American": ["美国", "美"],
    "Japan": ["日本"],
    "Japanese": ["日本"],
    "Korea": ["韩国"],
    "South Korea": ["韩国"],
    "North Korea": ["朝鲜"],
    "EU": ["欧盟"],
    "Europe": ["欧洲"],
    "UK": ["英国"],
    "Britain": ["英国"],
    "France": ["法国"],
    "Germany": ["德国"],
    "Israel": ["以色列"],
    "Palestine": ["巴勒斯坦"],
    "Iran": ["伊朗"],
    "Taiwan": ["台湾"],

    # Cryptocurrencies
    "Bitcoin": ["比特币"],
    "BTC": ["比特币"],
    "Ethereum": ["以太坊"],
    "ETH": ["以太坊"],
    "Solana": ["索拉纳"],
    "SOL": ["索拉纳"],
    "XRP": ["瑞波币"],
    "Ripple": ["瑞波"],
    "Dogecoin": ["狗狗币"],
    "DOGE": ["狗狗币"],
    "Cardano": ["卡尔达诺"],
    "ADA": ["卡尔达诺"],
    "Polkadot": ["波卡"],
    "DOT": ["波卡"],
    "Binance Coin": ["币安币"],
    "BNB": ["币安币"],

    # Institutions & Organizations
    "Fed": ["美联储", "联储"],
    "Federal Reserve": ["美联储", "联邦储备"],
    "FOMC": ["美联储会议", "联储会议"],
    "SEC": ["美国证监会", "证监会"],
    "FBI": ["美国联邦调查局", "联邦调查局"],
    "CIA": ["美国中情局", "中情局"],
    "NASA": ["美国航天局", "航天局"],
    "UN": ["联合国"],
    "United Nations": ["联合国"],
    "IMF": ["国际货币基金组织"],
    "WHO": ["世卫组织", "世界卫生组织"],
    "WTO": ["世贸组织", "世界贸易组织"],
    "NATO": ["北约"],
    "OPEC": ["欧佩克"],

    # People (Politicians)
    "Trump": ["川普", "特朗普"],
    "Donald Trump": ["川普", "特朗普"],
    "Biden": ["拜登"],
    "Joe Biden": ["拜登"],
    "Putin": ["普京"],
    "Vladimir Putin": ["普京"],
    "Zelenskyy": ["泽连斯基"],
    "Zelensky": ["泽连斯基"],
    "Xi": ["习近平"],
    "Xi Jinping": ["习近平"],
    "Obama": ["奥巴马"],
    "Clinton": ["克林顿"],
    "Bush": ["布什"],

    # People (Tech & Business)
    "Elon Musk": ["马斯克", "埃隆马斯克"],
    "Musk": ["马斯克"],
    "Mark Zuckerberg": ["扎克伯格"],
    "Zuckerberg": ["扎克伯格"],
    "Bill Gates": ["比尔盖茨", "盖茨"],
    "Gates": ["盖茨"],
    "Jeff Bezos": ["贝索斯"],
    "Bezos": ["贝索斯"],
    "Tim Cook": ["库克"],
    "Cook": ["库克"],
    "Steve Jobs": ["乔布斯"],
    "Jobs": ["乔布斯"],
    "Jack Ma": ["马云"],
    "CZ": ["赵长鹏", "CZ"],
    "Changpeng Zhao": ["赵长鹏"],
    "SBF": ["SBF", "班克曼"],
    "Sam Bankman-Fried": ["班克曼"],
    "Vitalik": ["V神", "维塔利克"],
    "Vitalik Buterin": ["V神", "维塔利克"],

    # Companies (Tech)
    "Apple": ["苹果"],
    "Microsoft": ["微软"],
    "Google": ["谷歌"],
    "Amazon": ["亚马逊"],
    "Meta": ["Meta", "脸书"],
    "Facebook": ["脸书", "Facebook"],
    "Tesla": ["特斯拉"],
    "Netflix": ["网飞", "奈飞"],
    "Nvidia": ["英伟达"],
    "AMD": ["AMD", "超威"],
    "Intel": ["英特尔"],
    "Samsung": ["三星"],
    "Huawei": ["华为"],
    "Xiaomi": ["小米"],
    "ByteDance": ["字节跳动"],
    "TikTok": ["TikTok", "抖音"],
    "Twitter": ["推特"],
    "X": ["X", "推特"],

    # Companies (Finance & Crypto)
    "Binance": ["币安"],
    "Coinbase": ["Coinbase", "Coinbase交易所"],
    "FTX": ["FTX"],
    "Kraken": ["Kraken"],
    "BlackRock": ["贝莱德"],
    "JPMorgan": ["摩根大通"],
    "Goldman Sachs": ["高盛"],
    "Morgan Stanley": ["摩根士丹利"],
    "Berkshire Hathaway": ["伯克希尔"],

    # Events & Awards
    "Olympics": ["奥运会", "奥运"],
    "Olympic Games": ["奥运会", "奥运"],
    "World Cup": ["世界杯"],
    "FIFA World Cup": ["世界杯"],
    "Super Bowl": ["超级碗"],
    "NBA": ["NBA", "美国职业篮球"],
    "NBA Finals": ["NBA总决赛"],
    "Oscars": ["奥斯卡"],
    "Academy Awards": ["奥斯卡", "学院奖"],
    "Grammy": ["格莱美"],
    "Emmy": ["艾美奖"],
    "Nobel Prize": ["诺贝尔奖"],
    "Champions League": ["欧冠", "欧洲冠军联赛"],

    # Products & Services
    "iPhone": ["苹果手机", "iPhone"],
    "iPad": ["iPad", "苹果平板"],
    "ChatGPT": ["ChatGPT"],
    "GPT": ["GPT"],
    "Claude": ["Claude"],
    "Gemini": ["Gemini", "双子座"],
}

# Entity Alias Map: canonical term -> list of aliases (abbreviations, variants)
# Used to augment entityGroups so that common abbreviations also trigger matches
ENTITY_ALIAS_MAP = {
    # Central Banks & Monetary Policy
    "bank of japan": ["boj", "日银", "日本央行", "日本银行"],
    "boj": ["bank of japan", "日银", "日本央行", "日本银行"],
    "federal reserve": ["fed", "fomc", "美联储", "联储"],
    "fed": ["federal reserve", "fomc", "美联储", "联储"],
    "fomc": ["fed", "federal reserve", "美联储"],
    "ecb": ["european central bank", "欧洲央行"],
    "european central bank": ["ecb", "欧洲央行"],
    "pboc": ["people's bank of china", "中国人民银行", "央行"],

    # Cryptocurrencies
    "bitcoin": ["btc", "比特币"],
    "btc": ["bitcoin", "比特币"],
    "ethereum": ["eth", "以太坊"],
    "eth": ["ethereum", "以太坊"],
    "solana": ["sol", "索拉纳"],
    "sol": ["solana", "索拉纳"],
    "xrp": ["ripple", "瑞波币"],
    "ripple": ["xrp", "瑞波"],
    "dogecoin": ["doge", "狗狗币"],
    "doge": ["dogecoin", "狗狗币"],
    "bnb": ["binance coin", "币安币"],

    # Exchanges & Crypto Companies
    "binance": ["bnb", "币安"],
    "coinbase": ["cb"],
    "ftx": ["ftx"],

    # People
    "elon musk": ["musk", "马斯克"],
    "musk": ["elon musk", "马斯克"],
    "changpeng zhao": ["cz", "赵长鹏"],
    "cz": ["changpeng zhao", "赵长鹏"],
    "vitalik buterin": ["vitalik", "v神", "维塔利克"],
    "vitalik": ["vitalik buterin", "v神"],
    "donald trump": ["trump", "川普", "特朗普"],
    "trump": ["donald trump", "川普", "特朗普"],
    "joe biden": ["biden", "拜登"],
    "biden": ["joe biden", "拜登"],

    # Companies
    "tesla": ["tsla", "特斯拉"],
    "apple": ["aapl", "苹果"],
    "nvidia": ["nvda", "英伟达"],
    "microsoft": ["msft", "微软"],
    "google": ["goog", "googl", "alphabet", "谷歌"],
    "amazon": ["amzn", "亚马逊"],
    "meta": ["fb", "facebook", "脸书"],

    # Sports & Events
    "super bowl": ["superbowl", "超级碗"],
    "nba finals": ["nba总决赛"],
    "world cup": ["世界杯"],
    "champions league": ["ucl", "欧冠"],
    "olympics": ["olympic games", "奥运会", "奥运"],
    "oscars": ["academy awards", "奥斯卡"],

    # Organizations
    "sec": ["securities and exchange commission", "美国证监会"],
    "fbi": ["federal bureau of investigation", "联邦调查局"],
    "nato": ["north atlantic treaty organization", "北约"],
}

# Keyword translations (for general keywords)
CN_EN_KEYWORD_MAP = {
    # War & Conflict
    "war": ["战争", "战事"],
    "conflict": ["冲突", "战争"],
    "ceasefire": ["停火", "停战", "和平协议"],
    "peace": ["和平", "和谈"],
    "peace treaty": ["和平协议", "和约"],
    "treaty": ["条约", "协议"],
    "invasion": ["入侵", "侵略"],
    "attack": ["攻击", "袭击"],
    "military": ["军事", "军队"],
    "army": ["军队", "陆军"],
    "weapon": ["武器"],
    "nuclear": ["核", "核武器"],
    "sanction": ["制裁"],
    "sanctions": ["制裁"],

    # Politics & Government
    "election": ["选举", "大选"],
    "vote": ["投票", "选举"],
    "president": ["总统"],
    "prime minister": ["总理", "首相"],
    "government": ["政府"],
    "congress": ["国会"],
    "parliament": ["议会"],
    "senator": ["参议员"],
    "representative": ["众议员", "代表"],
    "party": ["政党", "党派"],
    "democrat": ["民主党"],
    "republican": ["共和党"],
    "policy": ["政策"],
    "legislation": ["立法", "法律"],
    "bill": ["法案"],
    "law": ["法律"],
    "regulation": ["监管", "法规"],
    "impeachment": ["弹劾"],
    "resignation": ["辞职"],

    # Economy & Finance
    "interest rate": ["利率", "利息"],
    "rate": ["利率", "汇率"],
    "rate cut": ["降息"],
    "rate hike": ["加息"],
    "cut": ["降息", "削减"],
    "hike": ["加息", "上调"],
    "inflation": ["通货膨胀", "通胀"],
    "recession": ["衰退", "经济衰退"],
    "GDP": ["GDP", "国内生产总值"],
    "unemployment": ["失业", "失业率"],
    "job": ["就业", "工作"],
    "jobs": ["就业", "工作"],
    "employment": ["就业"],
    "stock": ["股票"],
    "stock market": ["股市", "股票市场"],
    "market": ["市场"],
    "price": ["价格"],
    "rally": ["上涨", "反弹"],
    "crash": ["崩盘", "暴跌"],
    "bull market": ["牛市"],
    "bear market": ["熊市"],
    "tariff": ["关税"],
    "trade war": ["贸易战"],
    "trade": ["贸易", "交易"],
    "export": ["出口"],
    "import": ["进口"],
    "currency": ["货币"],
    "dollar": ["美元"],
    "yuan": ["人民币"],
    "yen": ["日元"],

    # Crypto & Blockchain
    "cryptocurrency": ["加密货币", "数字货币"],
    "crypto": ["加密货币", "币圈"],
    "blockchain": ["区块链"],
    "DeFi": ["DeFi", "去中心化金融"],
    "NFT": ["NFT", "数字藏品"],
    "token": ["代币", "通证"],
    "coin": ["币", "代币"],
    "mining": ["挖矿"],
    "halving": ["减半"],
    "all-time high": ["历史新高", "新高"],
    "ATH": ["历史新高"],
    "all-time low": ["历史新低"],
    "ATL": ["历史新低"],
    "wallet": ["钱包"],
    "exchange": ["交易所"],
    "staking": ["质押"],
    "yield": ["收益"],
    "airdrop": ["空投"],
    "whitepaper": ["白皮书"],
    "mainnet": ["主网"],
    "testnet": ["测试网"],

    # Business & Corporate
    "acquisition": ["收购", "并购"],
    "acquire": ["收购"],
    "merger": ["合并", "并购"],
    "buyout": ["收购"],
    "takeover": ["收购", "接管"],
    "IPO": ["上市", "首次公开募股"],
    "listing": ["上市"],
    "delisting": ["退市"],
    "earnings": ["财报", "收益"],
    "revenue": ["营收", "收入"],
    "profit": ["利润"],
    "loss": ["亏损"],
    "bankruptcy": ["破产"],
    "CEO": ["首席执行官", "CEO"],
    "founder": ["创始人"],
    "layoff": ["裁员"],
    "layoffs": ["裁员"],
    "hire": ["招聘"],
    "hiring": ["招聘"],
    "valuation": ["估值"],
    "market cap": ["市值"],
    "FDV": ["完全稀释估值", "FDV"],
    "fully diluted valuation": ["完全稀释估值"],

    # Technology
    "AI": ["AI", "人工智能"],
    "artificial intelligence": ["人工智能"],
    "machine learning": ["机器学习"],
    "LLM": ["大语言模型", "LLM"],
    "launch": ["发布", "推出", "上线"],
    "release": ["发布", "发行"],
    "update": ["更新", "升级"],
    "upgrade": ["升级"],
    "version": ["版本"],
    "beta": ["测试版", "Beta"],
    "app": ["应用", "App"],
    "software": ["软件"],
    "hardware": ["硬件"],
    "chip": ["芯片"],
    "processor": ["处理器"],
    "smartphone": ["智能手机", "手机"],
    "phone": ["手机"],
    "computer": ["电脑", "计算机"],
    "laptop": ["笔记本电脑"],
    "tablet": ["平板电脑", "平板"],

    # Sports
    "championship": ["冠军", "锦标赛"],
    "winner": ["冠军", "获胜者"],
    "champion": ["冠军"],
    "final": ["决赛"],
    "finals": ["总决赛"],
    "semifinal": ["半决赛"],
    "quarter-final": ["四分之一决赛"],
    "match": ["比赛"],
    "game": ["比赛", "游戏"],
    "tournament": ["锦标赛", "比赛"],
    "season": ["赛季"],
    "playoff": ["季后赛"],
    "playoffs": ["季后赛"],
    "team": ["球队", "团队"],
    "player": ["球员", "选手"],
    "coach": ["教练"],
    "medal": ["奖牌"],
    "gold medal": ["金牌"],
    "silver medal": ["银牌"],
    "bronze medal": ["铜牌"],

    # Entertainment
    "movie": ["电影"],
    "film": ["电影"],
    "actor": ["演员"],
    "actress": ["女演员"],
    "director": ["导演"],
    "box office": ["票房"],
    "album": ["专辑"],
    "song": ["歌曲"],
    "music": ["音乐"],
    "artist": ["艺术家", "歌手"],
    "singer": ["歌手"],
    "concert": ["演唱会"],
    "tour": ["巡演", "巡回演出"],
    "award": ["奖项"],
    "nominee": ["提名"],
    "nomination": ["提名"],

    # General
    "yes": ["是", "对"],
    "no": ["不", "否"],
    "before": ["之前", "早于"],
    "after": ["之后", "晚于"],
    "by": ["在", "到"],
    "reach": ["达到", "触及"],
    "above": ["超过", "高于"],
    "below": ["低于", "以下"],
    "over": ["超过"],
    "under": ["低于"],
    "increase": ["增长", "上涨"],
    "decrease": ["下降", "下跌"],
    "rise": ["上涨", "上升"],
    "fall": ["下跌", "下降"],
    "growth": ["增长"],
    "decline": ["下降", "衰退"],
    "announce": ["宣布"],
    "announcement": ["公告", "宣布"],
    "report": ["报告", "报道"],
    "news": ["新闻"],
    "decision": ["决定"],
    "deal": ["交易", "协议"],
    "agreement": ["协议"],
    "contract": ["合同", "合约"],
}


def _now_epoch_seconds():
    return int(time.time())


def _format_utc8_time(epoch_seconds):
    """Format Unix timestamp as UTC+8 time string (YYYY-MM-DD HH:MM:SS UTC+8)."""
    utc8 = timezone(timedelta(hours=8))
    dt = datetime.fromtimestamp(epoch_seconds, tz=utc8)
    return dt.strftime("%Y-%m-%d %H:%M:%S UTC+8")


def _parse_cutoff_epoch_seconds(value):
    if value is None:
        return None

    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None

        # Try ISO-8601-ish strings using only `time`.
        # Examples: "2025-12-31T23:59:59Z", "2025-12-31 23:59:59", "2025-12-31T23:59:59.123Z"
        try:
            zulu = raw.endswith("Z")
            candidate = raw[:-1] if zulu else raw
            if "T" in candidate:
                candidate = candidate.replace("T", " ")
            if "." in candidate:
                candidate = candidate.split(".", 1)[0]

            for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
                try:
                    tm = time.strptime(candidate, fmt)
                    epoch_local = time.mktime(tm)
                    if zulu:
                        offset = time.altzone if time.localtime(epoch_local).tm_isdst else time.timezone
                        return int(epoch_local - offset)
                    return int(epoch_local)
                except ValueError:
                    pass
        except Exception:
            pass

    try:
        cutoff = int(float(value))
    except (TypeError, ValueError):
        return None

    if cutoff <= 0:
        return None

    if cutoff > 1_000_000_000_000:
        return int(cutoff / 1000)
    return cutoff


def _flatten_markets(node):
    flattened = []

    if isinstance(node, list):
        for item in node:
            flattened.extend(_flatten_markets(item))
        return flattened

    if not isinstance(node, dict):
        return flattened

    flattened.append(node)
    children = node.get("childMarkets")
    if isinstance(children, list) and children:
        for child in children:
            flattened.extend(_flatten_markets(child))
    return flattened


def fetch_all_markets():
    """Fetch all markets from Predictscan's Opinion markets API (full list, no auth)."""
    if DEBUG:
        print(f"[debug] fetching markets (full list) from {OPINION_API_URL}", flush=True)
    response = requests.get(OPINION_API_URL, timeout=30)
    response.raise_for_status()
    payload = response.json()

    # API variants: list | {data: [...]} | {list: [...]}.
    if isinstance(payload, dict):
        if isinstance(payload.get("data"), list):
            payload = payload["data"]
        elif isinstance(payload.get("list"), list):
            payload = payload["list"]

    if not isinstance(payload, list):
        raise ValueError("Predictscan market API error: Invalid response format (expected list)")
    return _flatten_markets(payload)


def fetch_parent_events():
    """Fetch parent event details from wrap-events API to check cutoffAt for multi-markets."""
    if DEBUG:
        print(f"[debug] fetching parent events from {OPINION_WRAP_EVENTS_URL}", flush=True)
    try:
        response = requests.get(OPINION_WRAP_EVENTS_URL, timeout=30)
        response.raise_for_status()
        payload = response.json()

        # Extract data array
        if isinstance(payload, dict) and isinstance(payload.get("data"), list):
            events_list = payload["data"]
        elif isinstance(payload, list):
            events_list = payload
        else:
            if DEBUG:
                print("[debug] wrap-events: unexpected format, returning empty dict", flush=True)
            return {}

        # Build event_id -> event_details mapping
        parent_events = {}
        for event in events_list:
            if not isinstance(event, dict):
                continue
            event_id = event.get("eventId") or event.get("marketId")
            if event_id:
                # Extract sub-markets information for multi-choice markets
                sub_markets = []
                markets_list = event.get("markets") or []
                if isinstance(markets_list, list):
                    for sub_market in markets_list:
                        if isinstance(sub_market, dict):
                            sub_markets.append({
                                "marketId": sub_market.get("marketId"),
                                "title": sub_market.get("title") or sub_market.get("marketTitle"),
                                "yesTokenId": sub_market.get("yesTokenId"),
                                "noTokenId": sub_market.get("noTokenId"),
                            })

                parent_events[str(event_id)] = {
                    "cutoffAt": event.get("cutoffAt"),
                    "statusEnum": event.get("statusEnum"),
                    "resolvedAt": event.get("resolvedAt"),
                    "title": event.get("title"),
                    "subMarkets": sub_markets if sub_markets else None,
                }

        if DEBUG:
            print(f"[debug] fetched {len(parent_events)} parent events", flush=True)
        return parent_events
    except Exception as exc:
        print(f"[warn] failed to fetch parent events from wrap-events API: {exc}", flush=True)
        return {}


def _market_id(market):
    # Prefer the canonical market identifier fields first.
    #
    # The Opinion API response may include both `id` and `marketId`; in some
    # payloads `id` can refer to a parent/event grouping identifier, which is
    # not unique per tradable market. Using it first can collapse many markets
    # into only a handful of IDs (overwriting entries in `markets_out`).
    for key in ("marketId", "market_id", "id"):
        value = market.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return None


def _market_title(market):
    # Prefer `marketTitle` per PRD; fall back to `title`.
    title = market.get("marketTitle") or market.get("title") or ""
    return str(title).strip()

def _market_parent_event(market):
    parent = market.get("parentEvent")
    return parent if isinstance(parent, dict) else None


def _market_parent_event_market_id(market):
    parent = _market_parent_event(market)
    if not parent:
        return None
    value = parent.get("eventMarketId")
    if value is None:
        return None
    value = str(value).strip()
    return value or None


def _market_parent_event_title(market):
    parent = _market_parent_event(market)
    if not parent:
        return ""
    title = parent.get("title") or ""
    return str(title).strip()


def _market_rules(market):
    rules = market.get("rules") or market.get("rule") or market.get("description") or ""
    return str(rules).strip()

def _market_volume(market):
    for key in (
        "volume",
        "volumeUsd",
        "volumeUSD",
        "volume24h",
        "totalVolume",
        "liquidity",
    ):
        if key in market and market.get(key) is not None:
            try:
                return float(market.get(key))
            except (TypeError, ValueError):
                pass
    return 0.0


def _is_processable_market(market, now_epoch_seconds):
    if market.get("statusEnum") != "Activated":
        return False

    resolved_at = _parse_cutoff_epoch_seconds(market.get("resolvedAt"))
    if resolved_at is not None and resolved_at > 0:
        return False

    cutoff = _parse_cutoff_epoch_seconds(market.get("cutoffAt"))
    if cutoff is None:
        # The API frequently returns `cutoffAt: 0` for still-active markets
        # (often option markets that belong to a `parentEvent`). Treat this
        # as "no cutoff" as long as the market is not resolved.
        raw_cutoff = market.get("cutoffAt")
        if raw_cutoff in (0, 0.0, "0", "0.0"):
            return True
        return False
    return cutoff > now_epoch_seconds


def _truncate(text, max_chars):
    if len(text) <= max_chars:
        return text
    return text[:max_chars].rstrip() + "..."


def _extract_json_array(text):
    cleaned = (text or "").strip()
    if not cleaned:
        return []

    if "```" in cleaned:
        parts = cleaned.split("```")
        for part in parts:
            candidate = part.strip()
            if candidate.startswith("[") and candidate.endswith("]"):
                cleaned = candidate
                break
            if candidate.startswith("json") and "[" in candidate and "]" in candidate:
                cleaned = candidate[candidate.find("[") : candidate.rfind("]") + 1].strip()
                break

    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        if DEBUG:
            preview = cleaned[:500].replace("\n", "\\n")
            print(f"[warn] LLM output was not valid JSON array; preview={preview}", flush=True)
        return []

    if not isinstance(data, list):
        return []

    keywords = []
    for item in data:
        if isinstance(item, str):
            kw = item.strip()
            if kw:
                keywords.append(kw)
    return keywords


def _extract_keywords_and_entities(text):
    """Extract keywords plus entity groups from AI response.

    Expected format:
    {
      "keywords": ["keyword1", "keyword2", ...],
      "entityGroups": [["entity_or_1", "entity_or_2"], ["another_entity"]]
    }

    Backwards compatibility:
    - Legacy object format with "entities": ["A", "B"] is treated as AND of singletons: [["A"], ["B"]]
    - Legacy array format is treated as keywords only.
    """
    cleaned = (text or "").strip()
    if not cleaned:
        return {"keywords": [], "entities": [], "entityGroups": []}

    # Try to extract JSON from markdown code blocks
    if "```" in cleaned:
        parts = cleaned.split("```")
        for part in parts:
            candidate = part.strip()
            # Try object format first
            if candidate.startswith("{") and candidate.endswith("}"):
                cleaned = candidate
                break
            # Try array format (legacy)
            if candidate.startswith("[") and candidate.endswith("]"):
                cleaned = candidate
                break
            # Handle json-prefixed code blocks
            if candidate.startswith("json"):
                if "{" in candidate and "}" in candidate:
                    cleaned = candidate[candidate.find("{") : candidate.rfind("}") + 1].strip()
                    break
                elif "[" in candidate and "]" in candidate:
                    cleaned = candidate[candidate.find("[") : candidate.rfind("]") + 1].strip()
                    break

    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        if DEBUG:
            preview = cleaned[:500].replace("\n", "\\n")
            print(f"[warn] LLM output was not valid JSON; preview={preview}", flush=True)
        return {"keywords": [], "entities": [], "entityGroups": []}

    # Handle new object format
    if isinstance(data, dict):
        keywords_raw = data.get("keywords", [])
        entity_groups_raw = data.get("entityGroups") or data.get("entity_groups") or data.get("ENTITY_GROUPS")
        entities_raw = data.get("entities", [])

        keywords = []
        if isinstance(keywords_raw, list):
            for item in keywords_raw:
                if isinstance(item, str):
                    kw = item.strip()
                    if kw:
                        keywords.append(kw)

        entity_groups = []
        if isinstance(entity_groups_raw, list):
            for group in entity_groups_raw:
                if isinstance(group, list):
                    g = []
                    for item in group:
                        if isinstance(item, str):
                            term = item.strip()
                            if term:
                                g.append(term)
                    if g:
                        entity_groups.append(g)
                elif isinstance(group, str):
                    term = group.strip()
                    if term:
                        entity_groups.append([term])

        # Legacy: "entities": ["A", "B"] means AND of required entities.
        if not entity_groups and isinstance(entities_raw, list):
            for item in entities_raw:
                if isinstance(item, str):
                    ent = item.strip()
                    if ent:
                        entity_groups.append([ent])

        entities = []
        for group in entity_groups:
            head = (group[0] if group else "").strip()
            if head and head not in entities:
                entities.append(head)

        return {"keywords": keywords, "entities": entities, "entityGroups": entity_groups}

    # Handle legacy array format (backwards compatibility)
    if isinstance(data, list):
        keywords = []
        for item in data:
            if isinstance(item, str):
                kw = item.strip()
                if kw:
                    keywords.append(kw)
        return {"keywords": keywords, "entities": [], "entityGroups": []}

    return {"keywords": [], "entities": [], "entityGroups": []}


def _normalize_keyword(keyword):
    kw = (keyword or "").strip().lower()
    kw = " ".join(kw.split())
    if kw.startswith('"') and kw.endswith('"') and len(kw) >= 2:
        kw = kw[1:-1].strip()
    return kw


_ENTITY_STOP_TERMS = {
    "crypto",
    "web3",
    "market",
    "markets",
    "team",
    "human",
    "ai",
    "teamai",
    "teamhuman",
    "humanvsai",
    "price",
    "defi",
    "token",
    "airdrop",
    "launch",
    "ipo",
    "tge",
    "fdv",
    "ath",
    "all time high",
    "rate decision",
    "fed rate decision",
    "interest rate",
    "interest rates",
    "rate cut",
    "rate hike",
    "yes",
    "no",
    "other",
    "resolution",
    "settlement",
    "settled",
    "increase",
    "decrease",
    "no change",
    "nochange",
    "unchanged",
    "hold",
    "winner",
    "champion",
    "acquire",
    "acquired",
    "acquirer",
    "acquisition",
    "buyout",
    "takeover",
    "closing",
    "close",
    "deal",
    "announced",
    "announce",
    "official",
    "announcement",
    "officialannouncement",
    "developer",
    "company",
    "brand",
    "investor",
    "buyer",
    "seller",
    "market cap",
    "marketcap",
    "valuation",
    "ticker",
    "exchange",
    "nasdaq",
    "nyse",
    "sec",
}

_ENTITY_MONTHS = {
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
    "jan",
    "feb",
    "mar",
    "apr",
    "jun",
    "jul",
    "aug",
    "sep",
    "sept",
    "oct",
    "nov",
    "dec",
}

_ENTITY_TIME_WORDS = {
    "before",
    "after",
    "until",
    "till",
    "by",
    "within",
}

_ENTITY_ALLOW_SHORT = {
    # CZ is a common 2-letter identifier on X.
    "cz",
}

_GENERIC_ENTITY_TOKENS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "before",
    "after",
    "until",
    "till",
    "within",
    "end",
    "for",
    "from",
    "has",
    "have",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "the",
    "to",
    "will",
    "with",
    "who",
    "which",
    "what",
    "winner",
    "champion",
    "best",
    "released",
    "release",
    "launch",
    "launched",
    "announced",
    "announce",
    "acquire",
    "acquired",
    "acquisition",
    "buyout",
    "takeover",
    "decision",
    "rate",
    "rates",
    "human",
    "ai",
    "team",
    "vs",
}

_ENTITY_ALLOWED_CONNECTORS = {
    "a",
    "an",
    "and",
    "of",
    "the",
    "to",
    "in",
    "on",
    "for",
    "at",
}

_ENTITY_DISALLOWED_QUESTION_WORDS = {
    "will",
    "who",
    "what",
    "which",
    "when",
    "where",
    "why",
    "how",
}


def _is_valid_entity_term(normalized_term):
    term = _normalize_keyword(normalized_term)
    if not term:
        return False

    if term in _ENTITY_STOP_TERMS:
        return False

    # Disallow obvious outcome tokens like "teamai"/"teamhuman".
    if term.startswith("team") and len(term) <= 12:
        return False

    tokens = term.split()
    if len(tokens) > 4:
        return False

    # Disallow obvious question/auxiliary words anywhere in the entity phrase.
    if any(tok in _ENTITY_DISALLOWED_QUESTION_WORDS for tok in tokens):
        return False

    if any(tok in _ENTITY_MONTHS for tok in tokens):
        return False

    if any(tok in _ENTITY_TIME_WORDS for tok in tokens):
        return False

    if any(tok.isdigit() and len(tok) == 4 for tok in tokens):
        return False

    # Reject single-token generic words (e.g. "will", "company").
    if len(tokens) == 1 and tokens[0] in _GENERIC_ENTITY_TOKENS:
        return False

    # For multi-word entities, allow light connector words, but reject generic content words
    # that typically encode outcomes or mechanics (e.g. "launch", "acquire", "decision").
    if len(tokens) >= 2 and any(
        (tok in _GENERIC_ENTITY_TOKENS) and (tok not in _ENTITY_ALLOWED_CONNECTORS) for tok in tokens
    ):
        return False

    # Reject phrases that are composed entirely of generic glue words.
    if len(tokens) >= 2 and all((tok in _GENERIC_ENTITY_TOKENS) or tok.isdigit() for tok in tokens):
        return False

    # Reject basis-points tokens like "25bp"/"25bps".
    if any(re.match(r"^\d{1,3}(?:bp|bps|basispoints?)$", tok) for tok in tokens):
        return False

    if term.isdigit() and len(term) == 4:
        return False

    if len(term) < 3 and term not in _ENTITY_ALLOW_SHORT:
        return False

    # Drop month+day tokens like "dec31", "dec31st", etc.
    if any(re.match(r"^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\d{1,2}(?:st|nd|rd|th)?$", tok) for tok in tokens):
        return False

    # Drop date-like strings such as "2025-12-31" or "12/31/2025".
    if re.search(r"\b(19|20)\d{2}[-/]\d{1,2}[-/]\d{1,2}\b", term):
        return False
    if re.search(r"\b\d{1,2}[-/]\d{1,2}[-/](19|20)\d{2}\b", term):
        return False

    return True


def _compact_alnum(text):
    return re.sub(r"[^a-z0-9]+", "", str(text or "").lower())

def _allowed_entity_alias_terms_from_title(title):
    lower = str(title or "").lower()
    allow = set()

    if ("bitcoin" in lower) or re.search(r"\bbtc\b", lower):
        allow.update({"btc", "bitcoin"})

    if ("ethereum" in lower) or re.search(r"\beth\b", lower):
        allow.update({"eth", "ethereum"})

    if ("fomc" in lower) or ("federal reserve" in lower) or re.search(r"\bfed\b", lower):
        allow.update({"fed", "fomc", "federalreserve", "federal reserve"})

    if "binance" in lower:
        allow.update({"binance"})

    if re.search(r"\bcz\b", lower) or ("changpeng zhao" in lower) or ("changpengzhao" in lower):
        allow.update({"cz", "changpengzhao", "changpeng zhao"})

    return allow


def _term_is_from_title(term, title, allow_terms):
    nterm = _normalize_keyword(term)
    if not nterm:
        return False
    if nterm in (allow_terms or set()):
        return True
    # Allow Chinese characters (these are dictionary translations, not from title)
    # Chinese character range: U+4E00 to U+9FFF
    if any('\u4e00' <= ch <= '\u9fff' for ch in nterm):
        return True
    t_compact = _compact_alnum(title)
    n_compact = _compact_alnum(nterm)
    return bool(n_compact and t_compact and n_compact in t_compact)


def _normalize_entity_groups(entity_groups, title, allow_terms, max_groups=2, max_terms=4):
    normalized = []
    if not isinstance(entity_groups, list) or not entity_groups:
        return normalized

    for group in entity_groups:
        if not isinstance(group, list):
            continue
        ng = []
        for term in group:
            if not isinstance(term, str):
                continue
            nterm = _normalize_keyword(term)
            if not nterm:
                continue
            if not _is_valid_entity_term(nterm):
                continue
            if not _term_is_from_title(nterm, title, allow_terms):
                continue
            if nterm not in ng:
                ng.append(nterm)
            if len(ng) >= max_terms:
                break
        if ng:
            normalized.append(ng)
        if len(normalized) >= max_groups:
            break
    return normalized


def _collect_invalid_entity_terms(entity_groups, entities, title, allow_terms):
    bad = []

    def add(term):
        nterm = _normalize_keyword(term)
        if not nterm:
            return
        if nterm not in bad:
            bad.append(nterm)

    if isinstance(entity_groups, list):
        for group in entity_groups:
            terms = group if isinstance(group, list) else ([group] if isinstance(group, str) else [])
            for term in terms:
                if not isinstance(term, str):
                    continue
                nterm = _normalize_keyword(term)
                if not nterm:
                    continue
                if not _is_valid_entity_term(nterm):
                    add(nterm)
                elif not _term_is_from_title(nterm, title, allow_terms):
                    add(nterm)

    if isinstance(entities, list):
        for term in entities:
            if isinstance(term, str):
                nterm = _normalize_keyword(term)
                if not nterm:
                    continue
                if not _is_valid_entity_term(nterm):
                    add(nterm)
                elif not _term_is_from_title(nterm, title, allow_terms):
                    add(nterm)

    return bad[:20]


def _fallback_entity_groups_from_title(title):
    raw = str(title or "").strip()
    if not raw:
        return []

    lower = raw.lower()
    groups = []

    if "tiktok" in lower:
        return [["tiktok"]]

    if "oscars" in lower or "academy awards" in lower:
        return [["oscars", "academy awards", "oscar"]]

    if "super bowl" in lower:
        return [["super bowl", "nfl", "super bowl champion"]]

    if "world cup" in lower:
        return [["world cup", "fifa world cup", "fifa"]]

    if "champions league" in lower:
        return [["champions league", "uefa champions league", "uefa"]]

    if "premier league" in lower or re.search(r"\bepl\b", lower):
        return [["premier league", "english premier league", "epl"]]

    if "la liga" in lower or "laliga" in lower:
        return [["la liga", "laliga"]]

    if ("fomc" in lower) or ("federal reserve" in lower) or re.search(r"\bfed\b", lower):
        groups.append(["fed", "fomc", "federal reserve", "federalreserve"])
    if ("bitcoin" in lower) or re.search(r"\bbtc\b", lower):
        groups.append(["btc", "bitcoin"])
    if ("ethereum" in lower) or re.search(r"\beth\b", lower):
        groups.append(["eth", "ethereum"])
    if "binance" in lower:
        groups.append(["binance"])
    if re.search(r"\bcz\b", lower) or ("changpeng zhao" in lower):
        groups.append(["cz", "changpengzhao"])

    seen = set()
    for g in groups:
        for t in g:
            seen.add(t)

    candidates = []
    for token in _simple_tokenize(raw):
        token = str(token or "").lstrip("$#")
        term = _normalize_keyword(token)
        if not term:
            continue
        candidates.append(term)

    candidates.extend(_title_ngram_keywords(raw, max_phrases=24))

    scored = []
    for cand in candidates:
        cand = _normalize_keyword(cand)
        if not cand or cand in seen:
            continue
        if not _is_valid_entity_term(cand):
            continue
        if not _term_is_from_title(cand, raw, allow_terms=set()):
            continue
        toks = cand.split()
        specificity = sum(1 for t in toks if (t not in _GENERIC_ENTITY_TOKENS) and (not t.isdigit()))
        scored.append((specificity, len(toks), len(cand), cand))

    if scored and len(groups) < 2:
        scored.sort(
            key=lambda x: (
                -x[0],
                (x[1] if x[0] > 0 else -x[1]),
                (x[2] if x[0] > 0 else -x[2]),
            )
        )
        best = scored[0][3]
        groups.append([best])

    return groups


def _simple_tokenize(text):
    if not text:
        return []
    s = str(text)
    out = []
    cur = []
    for i in range(len(s)):
        ch = s[i]
        o = ord(ch)
        is_ascii_alnum = (48 <= o <= 57) or (65 <= o <= 90) or (97 <= o <= 122)
        if is_ascii_alnum:
            cur.append(ch.lower())
            continue

        # Keep simple pairs like "btc/usdt" together.
        if ch == "/" and cur:
            if i + 1 < len(s):
                nxt = s[i + 1]
                no = ord(nxt)
                nxt_is_ascii_alnum = (48 <= no <= 57) or (65 <= no <= 90) or (97 <= no <= 122)
                if nxt_is_ascii_alnum:
                    cur.append("/")
                    continue

        # Keep simple pairs like "gpt-6" together.
        if ch == "-" and cur:
            if i + 1 < len(s):
                nxt = s[i + 1]
                no = ord(nxt)
                nxt_is_ascii_alnum = (48 <= no <= 57) or (65 <= no <= 90) or (97 <= no <= 122)
                if nxt_is_ascii_alnum:
                    cur.append("-")
                    continue

        # Keep "$btc" together.
        if ch == "$":
            if cur:
                out.append("".join(cur))
                cur = []
            cur.append("$")
            continue

        if cur:
            out.append("".join(cur))
            cur = []

    if cur:
        out.append("".join(cur))
    return out


def _fallback_keywords(event_title, option_titles, rules_text, max_keywords=25):
    stop = {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "before",
        "by",
        "end",
        "for",
        "from",
        "has",
        "have",
        "in",
        "is",
        "it",
        "of",
        "on",
        "or",
        "the",
        "to",
        "will",
        "with",
    }
    text = (event_title or "") + " " + " ".join(option_titles or []) + "\n" + (rules_text or "")
    words = _simple_tokenize(text)
    keywords = []
    for w in words:
        if len(w) < 3 and not (w.startswith("$") and len(w) >= 3):
            continue
        if w in stop:
            continue
        if len(w) > 40:
            continue
        if w not in keywords:
            keywords.append(w)
        if len(keywords) >= max_keywords:
            break
    if event_title:
        normalized_title = _normalize_keyword(event_title)
        if normalized_title and normalized_title not in keywords and len(normalized_title) <= 80:
            keywords.insert(0, normalized_title)
    return keywords


def _title_ngram_keywords(title, max_phrases=12):
    stop = {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "before",
        "by",
        "end",
        "for",
        "from",
        "has",
        "have",
        "in",
        "is",
        "it",
        "of",
        "on",
        "or",
        "the",
        "to",
        "will",
        "with",
    }

    words = [w for w in _simple_tokenize(title or "") if w and w not in stop]
    # Drop extremely short tokens except year-like numbers.
    filtered = []
    for w in words:
        if w.isdigit() and len(w) == 4:
            filtered.append(w)
            continue
        if w.startswith("$") and len(w) >= 3:
            filtered.append(w)
            continue
        if len(w) >= 3:
            filtered.append(w)

    phrases = []
    # bigrams
    for i in range(len(filtered) - 1):
        a = filtered[i]
        b = filtered[i + 1]
        if a == b:
            continue
        phrases.append(f"{a} {b}")
    # trigrams
    for i in range(len(filtered) - 2):
        a = filtered[i]
        b = filtered[i + 1]
        c = filtered[i + 2]
        phrases.append(f"{a} {b} {c}")

    out = []
    for p in phrases:
        p = _normalize_keyword(p)
        if not p:
            continue
        if len(p) > 60:
            continue
        if p not in out:
            out.append(p)
        if len(out) >= max_phrases:
            break
    return out


def _djb2_32(text):
    h = 5381
    for ch in text:
        h = ((h << 5) + h + ord(ch)) & 0xFFFFFFFF
    return h


def _event_signature_core(event_title, rules_best):
    title = str(event_title or "").strip()
    rules_preview = str(rules_best or "").strip()[:1200]
    payload = {
        "title": title,
        "rules": rules_preview,
    }
    stable = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"{_djb2_32(stable):08x}"


def _event_signature_full(event_title, market_ids, option_titles_all, rules_best):
    title = str(event_title or "").strip()
    options = [str(x).strip() for x in (option_titles_all or []) if str(x).strip()]
    unique_options = sorted(set(options))[:80]
    rules_preview = str(rules_best or "").strip()[:1200]
    payload = {
        "title": title,
        "optionCount": len(market_ids or []),
        "options": unique_options,
        "rules": rules_preview,
    }
    stable = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"{_djb2_32(stable):08x}"


def _load_previous_data(output_path):
    """Load previous data.json for incremental updates.

    Priority:
    1. If PREVIOUS_DATA_URL env var is set, try to download from that URL
    2. If download fails or env var not set, try to load from local file (output_path)
    3. If both fail, return None (full rebuild)
    """
    # Try loading from remote URL first (for GitHub Actions)
    previous_data_url = os.environ.get("PREVIOUS_DATA_URL", "").strip()
    if previous_data_url:
        try:
            print(f"[info] attempting to load previous data from URL: {previous_data_url}", flush=True)
            response = requests.get(previous_data_url, timeout=30)
            if response.status_code == 200:
                data = response.json()
                if isinstance(data, dict):
                    print("[info] successfully loaded previous data from URL", flush=True)
                    return data
            elif response.status_code == 404:
                print("[info] previous data not found at URL (404), will do full rebuild", flush=True)
            else:
                print(f"[warn] failed to fetch previous data from URL: HTTP {response.status_code}", flush=True)
        except Exception as exc:
            print(f"[warn] failed to load previous data from URL: {exc}", flush=True)

    # Fallback to local file
    try:
        if output_path and os.path.exists(output_path):
            with open(output_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                print("[info] loaded previous data from local file", flush=True)
                return data
    except Exception as exc:
        if DEBUG:
            print(f"[warn] failed to load previous data from local file: {exc}", flush=True)

    return None


def _zhipu_chat_completion(api_key, messages):
    if hasattr(zhipuai, "ZhipuAI"):
        try:
            client = zhipuai.ZhipuAI(api_key=api_key, timeout=ZHIPU_TIMEOUT_SECONDS)
        except TypeError:
            client = zhipuai.ZhipuAI(api_key=api_key)

        try:
            resp = client.chat.completions.create(
                model=MODEL_NAME,
                messages=messages,
                temperature=0.2,
                top_p=0.7,
                timeout=ZHIPU_TIMEOUT_SECONDS,
            )
        except TypeError:
            resp = client.chat.completions.create(
                model=MODEL_NAME,
                messages=messages,
                temperature=0.2,
                top_p=0.7,
            )
        return resp.choices[0].message.content

    zhipuai.api_key = api_key
    resp = zhipuai.model_api.invoke(
        model=MODEL_NAME,
        prompt=messages,
        temperature=0.2,
        top_p=0.7,
    )

    if isinstance(resp, dict):
        for path in (
            ("data", "choices", 0, "content"),
            ("data", "choices", 0, "message", "content"),
            ("choices", 0, "message", "content"),
            ("choices", 0, "content"),
        ):
            cur = resp
            ok = True
            for key in path:
                if isinstance(key, int) and isinstance(cur, list) and len(cur) > key:
                    cur = cur[key]
                elif isinstance(cur, dict) and key in cur:
                    cur = cur[key]
                else:
                    ok = False
                    break
            if ok and isinstance(cur, str):
                return cur

    return str(resp)


def generate_keywords(api_key, title, rules, context=None):
    """Generate keywords and entities for a prediction market.

    Returns:
        dict with keys:
        - "keywords": list of keyword strings
        - "entities": list of 1-3 canonical entity strings (for display/debug)
        - "entityGroups": list of OR-groups; all groups required (AND)
    """
    system = (
        "You generate high-quality matching keywords and strict subject-identifying entity requirements for a prediction market. "
        "Return ONLY a JSON object (no prose). "
        "Include keywords (general terms, synonyms, slang) and entityGroups (high-precision identifiers)."
    )
    avoid_terms = None
    if isinstance(context, dict):
        avoid_terms = context.get("avoidEntityTerms")
    avoid_terms_list = []
    if isinstance(avoid_terms, (list, tuple)):
        for t in avoid_terms:
            nt = _normalize_keyword(t)
            if nt and nt not in avoid_terms_list:
                avoid_terms_list.append(nt)
            if len(avoid_terms_list) >= 20:
                break

    avoid_block = ""
    if avoid_terms_list:
        avoid_joined = ", ".join(avoid_terms_list)
        avoid_block = (
            "\n"
            "Previous attempt produced invalid entity terms. DO NOT use any of these in entityGroups:\n"
            f"- Avoid: {avoid_joined}\n"
        )

    user = (
        f"Market title: {title}\n"
        f"Market rules: {_truncate(rules, 1200)}\n\n"
        "Rules:\n"
        "- Output must be a JSON object with 'keywords' and 'entityGroups' fields (no extra fields).\n"
        "- keywords: 10-15 English search terms (entities, synonyms, abbreviations, slang)\n"
        "  * Keep keywords in English only for now\n"
        "- entityGroups: STRICT subject-identifying requirements as an AND-of-ORs (CNF) with bilingual support\n"
        "  * entityGroups is a list of groups; ALL groups are required (AND)\n"
        "  * each group is a list of synonyms; ANY term in the group can satisfy it (OR)\n"
        "  * Put the CANONICAL English form FIRST in each group, then add Chinese translations for major entities\n"
        "  * Use 1-2 groups total; keep each group to 2-6 terms (including Chinese translations)\n"
        "  * Each term should be a short identifier (1-3 words) or a ticker\n"
        "  * IMPORTANT: Include Chinese translations in entityGroups for well-known entities:\n"
        "    - Countries: Russia → 俄罗斯, Ukraine → 乌克兰, China → 中国\n"
        "    - Crypto: Bitcoin → 比特币, Ethereum → 以太坊\n"
        "    - People: Trump → 川普, Putin → 普京, Musk → 马斯克\n"
        "    - Companies: Tesla → 特斯拉, Apple → 苹果, Binance → 币安\n"
        "    - Institutions: Fed/FOMC → 美联储\n"
        "    - Events: Olympics → 奥运会, Oscars → 奥斯卡\n"
        "  * entityGroups terms MUST identify the market's SUBJECT, not its outcomes/options\n"
        "  * entityGroups terms MUST come from the market title (you may add common aliases)\n"
        "  * NEVER use question/aux words as entities: will, who, what, which, when, where, why, how\n"
        "  * NEVER use generic/outcome/mechanics terms as entities: yes, no, other, winner, champion, increase, decrease, nochange, hold, resolution, settlement,\n"
        "    market cap, valuation, launch, ipo, tge, fdv, ath, exchange, nasdaq, nyse, sec\n"
        "  * DO NOT put candidate options, answer labels, or alternative outcomes into entityGroups\n"
        "    - Bad: listing teams/nominees/companies as separate required groups for 'Winner' markets\n"
        "    - Bad: yes/no/other, increase/decrease/nochange, dates, months, times, price thresholds, marketcap/valuation, exchanges, tickers like ETHUSDT\n"
        "  * If the title is a 'winner/which ...' style multi-option market, use only the overarching subject in the title\n"
        "    (e.g., Oscars/NBA/Super Bowl/World Cup/TikTok), NOT the candidate list.\n"
        "  * If the market is about two key subjects that must both be mentioned (e.g., 'X vs Y', 'X acquires Y'), use 2 groups.\n"
        f"{avoid_block}"
        "- Prefer short phrases over sentences.\n"
        "- Do not include duplicates.\n"
        "\n"
        "Entity examples (with Chinese in entityGroups):\n"
        '- Title: "Will ETH all time high by 2025-12-31?" -> entityGroups: [["ETH", "Ethereum", "以太坊"]]\n'
        '- Title: "Will CZ return to Binance before 2025?" -> entityGroups: [["CZ", "Changpeng Zhao", "赵长鹏"], ["Binance", "币安"]]\n'
        '- Title: "US Fed Rate Decision in January?" -> entityGroups: [["Fed", "FOMC", "Federal Reserve", "美联储"]]\n'
        '- Title: "Russia x Ukraine ceasefire by ...?" -> entityGroups: [["Russia", "俄罗斯"], ["Ukraine", "乌克兰"]]\n'
        '- Title: "Oscars 2026: Best Actor Winner" -> entityGroups: [["Oscars", "Academy Awards", "Oscar", "奥斯卡"]]\n'
        '- Title: "Who will acquire TikTok?" -> entityGroups: [["TikTok", "抖音"]]\n'
        '- Title: "Tesla stock above $300?" -> entityGroups: [["Tesla", "特斯拉"]]\n'
        "\n"
        "Example output format:\n"
        '{\n'
        '  "keywords": ["Russia", "Ukraine", "war", "ceasefire", "peace", "conflict"],\n'
        '  "entityGroups": [["Russia", "俄罗斯"], ["Ukraine", "乌克兰"]]\n'
        "}\n"
    )

    attempt = 0
    ctx = context if isinstance(context, dict) else {}
    ctx_event_id = str(ctx.get("eventId") or "").strip() or None
    ctx_best_market_id = str(ctx.get("bestMarketId") or "").strip() or None
    ctx_best_market_url = str(ctx.get("bestMarketUrl") or "").strip() or None
    ctx_label_parts = []
    if ctx_event_id:
        ctx_label_parts.append(f"eventId={ctx_event_id}")
    if ctx_best_market_id:
        ctx_label_parts.append(f"bestMarketId={ctx_best_market_id}")
    if ctx_best_market_url:
        ctx_label_parts.append(f"url={ctx_best_market_url}")
    ctx_label = (" " + " ".join(ctx_label_parts)) if ctx_label_parts else ""

    while True:
        attempt += 1
        try:
            content = _zhipu_chat_completion(
                api_key=api_key,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            )
            result = _extract_keywords_and_entities(content)
            if DEBUG:
                print(
                    f"[debug] generated for title={title!r}: "
                    f"keywords={len(result['keywords'])} entities={len(result['entities'])} (attempt {attempt})",
                    flush=True,
                )
            return result
        except KeyboardInterrupt:
            raise
        except Exception as exc:
            if attempt >= max(1, ZHIPU_MAX_RETRIES):
                safe_title = _truncate(str(title or "").strip(), 160)
                print(
                    f"[warn] keyword generation failed (final){ctx_label} title={safe_title!r}: {exc}",
                    flush=True,
                )
                return {"keywords": [], "entities": [], "entityGroups": []}
            sleep_for = min(2.0, 0.5 * attempt)
            if DEBUG:
                safe_title = _truncate(str(title or "").strip(), 160)
                print(
                    f"[warn] keyword generation failed (retrying){ctx_label} title={safe_title!r}: {exc}",
                    flush=True,
                )
            time.sleep(sleep_for)


def augment_with_chinese(keywords, entities, entity_groups):
    """Augment LLM-generated entityGroups with Chinese translations and aliases from dictionaries.

    This function uses predefined dictionaries to add:
    1. Chinese translations (from CN_EN_ENTITY_MAP and CN_EN_KEYWORD_MAP)
    2. Common aliases/abbreviations (from ENTITY_ALIAS_MAP)

    This ensures that common abbreviations like "BOJ" trigger matches when "Bank of Japan"
    is in the entityGroups.

    Args:
        keywords: List of keyword strings (returned unchanged)
        entities: List of canonical entity strings (for backward compatibility)
        entity_groups: List of entity groups (AND-of-OR structure)

    Returns:
        Tuple of (keywords, augmented_entity_groups)
    """
    if not isinstance(keywords, list):
        keywords = []
    if not isinstance(entity_groups, list):
        entity_groups = []

    # Keywords are returned unchanged - we only augment entityGroups
    # Augment entityGroups with Chinese translations and aliases
    new_entity_groups = []
    for group in entity_groups:
        if not isinstance(group, list):
            continue

        new_group = list(group)  # Start with original group
        group_terms_set = set(_normalize_keyword(t) for t in new_group if t)

        for term in list(group):
            term_normalized = _normalize_keyword(term)
            if not term_normalized:
                continue

            # Check entity map for Chinese translations
            for en_key, cn_translations in CN_EN_ENTITY_MAP.items():
                en_key_lower = en_key.lower()
                term_lower = term_normalized.lower()

                # Exact match or term contains the key
                if en_key_lower == term_lower or (len(en_key_lower) >= 3 and en_key_lower in term_lower):
                    for cn_term in cn_translations:
                        cn_normalized = _normalize_keyword(cn_term)
                        if cn_normalized and cn_normalized not in group_terms_set:
                            new_group.append(cn_term)
                            group_terms_set.add(cn_normalized)

            # Check keyword map for entity terms
            for en_key, cn_translations in CN_EN_KEYWORD_MAP.items():
                en_key_lower = en_key.lower()
                term_lower = term_normalized.lower()

                # Exact match
                if en_key_lower == term_lower:
                    for cn_term in cn_translations:
                        cn_normalized = _normalize_keyword(cn_term)
                        if cn_normalized and cn_normalized not in group_terms_set:
                            new_group.append(cn_term)
                            group_terms_set.add(cn_normalized)

            # Check alias map for abbreviations and variants
            for canonical, aliases in ENTITY_ALIAS_MAP.items():
                canonical_lower = canonical.lower()
                term_lower = term_normalized.lower()

                # Exact match with canonical term
                if canonical_lower == term_lower:
                    for alias in aliases:
                        alias_normalized = _normalize_keyword(alias)
                        if alias_normalized and alias_normalized not in group_terms_set:
                            new_group.append(alias)
                            group_terms_set.add(alias_normalized)

        if new_group:
            new_entity_groups.append(new_group)

    # If we didn't create new groups (empty input), preserve original structure
    if not new_entity_groups and entity_groups:
        new_entity_groups = entity_groups

    if DEBUG:
        for i, (old_group, new_group) in enumerate(zip(entity_groups, new_entity_groups)):
            added_entities = len(new_group) - len(old_group)
            if added_entities > 0:
                print(f"[debug] augment_with_chinese: added {added_entities} terms (Chinese + aliases) to entityGroup[{i}]", flush=True)

    return keywords, new_entity_groups


def build_data(markets, api_key, previous_data=None, parent_events=None):
    now = _now_epoch_seconds()
    parent_events = parent_events or {}

    markets_out = {}
    events_out = {}
    inverted = {}
    event_inverted = {}

    processed = 0
    kept = 0
    duplicate_event_market_ids = 0
    skipped = {
        "statusEnum": 0,
        "cutoff_missing_or_invalid": 0,
        "cutoff_expired": 0,
        "cutoff_zero_kept": 0,
        "resolved": 0,
        "missing_id": 0,
        "missing_title": 0,
        "title_pattern_filtered": 0,
    }
    ai_stats = {
        "previousLoaded": isinstance(previous_data, dict),
        "fullAiRefresh": bool(FULL_AI_REFRESH),
        "onlyAiForNew": False,
        "reused": 0,
        "regenerated_empty_entitygroups": 0,
        "calls": 0,
        "retries": 0,
        "fallback": 0,
        "empty": 0,
        "non_empty": 0,
        "errors": 0,
    }
    event_stats = {
        "events": 0,
    }

    max_markets_env = os.environ.get("MAX_MARKETS")
    max_markets = int(max_markets_env) if (max_markets_env and max_markets_env.isdigit()) else None
    max_events_env = os.environ.get("MAX_EVENTS")
    max_events = int(max_events_env) if (max_events_env and max_events_env.isdigit()) else None
    sleep_seconds = float(os.environ.get("SLEEP_SECONDS", "0.2"))
    scan_log_every = int(os.environ.get("SCAN_LOG_EVERY", "100"))

    if max_markets is not None or max_events is not None:
        print(
            "[info] sampling enabled: MAX_MARKETS=%r MAX_EVENTS=%r" % (max_markets_env, max_events_env),
            flush=True,
        )

    event_accumulator = {}
    prev_events = {}
    prev_markets = {}
    if isinstance(previous_data, dict):
        prev_events = previous_data.get("events") or {}
        if not isinstance(prev_events, dict):
            prev_events = {}
        prev_markets = previous_data.get("markets") or {}
        if not isinstance(prev_markets, dict):
            prev_markets = {}

    only_ai_for_new = (not FULL_AI_REFRESH) and bool(prev_events) and bool(prev_markets)
    existing_event_ids = set(prev_events.keys()) if only_ai_for_new else set()
    existing_market_ids = set(prev_markets.keys()) if only_ai_for_new else set()
    if only_ai_for_new:
        markets_out = dict(prev_markets)
        events_out = dict(prev_events)
    ai_stats["onlyAiForNew"] = bool(only_ai_for_new)

    # Track resolved event IDs to remove them from output later
    resolved_event_ids = set()
    # Track all event IDs seen in current API response (to detect missing events in incremental mode)
    current_api_event_ids = set()
    # Track pseudo-parent event IDs (binary markets wrapped as events) to remove them from events_out
    pseudo_parent_event_ids = set()

    for market in markets:
        processed += 1
        if max_markets is not None and kept >= max_markets:
            break
        if scan_log_every > 0 and processed % scan_log_every == 0:
            print(f"[info] scanned {processed} market nodes (kept {kept})", flush=True)

        market_id = _market_id(market)
        parent_event_title = _market_parent_event_title(market)
        parent_event_market_id = _market_parent_event_market_id(market)
        parent_event_id = market.get("parentEventId")
        event_id = parent_event_market_id or (str(parent_event_id).strip() if parent_event_id else None) or market_id

        # Determine if this is a child market (sub-market of a multi-choice event)
        # Only independent markets (not child markets) should trigger event removal
        is_child_market = parent_event_id and str(parent_event_id).strip() and (market_id != event_id)

        # Record this event_id as seen in current API (regardless of status)
        if event_id and only_ai_for_new:
            current_api_event_ids.add(event_id)

        if market.get("statusEnum") != "Activated":
            skipped["statusEnum"] += 1
            # Track resolved/inactive events to remove from previous data
            # Only mark independent markets (non-child markets) for removal
            if event_id and only_ai_for_new and not is_child_market:
                resolved_event_ids.add(event_id)
            continue

        # Also check parent event's statusEnum if this is a child market
        # Only skip if parent is explicitly Resolved (not just Created/inactive)
        if is_child_market and event_id and event_id in parent_events:
            parent_status = parent_events[event_id].get("statusEnum")
            if parent_status == "Resolved":
                skipped["statusEnum"] += 1
                # Skip this child market if parent event is resolved
                if event_id and only_ai_for_new:
                    resolved_event_ids.add(event_id)
                continue

        resolved_at = _parse_cutoff_epoch_seconds(market.get("resolvedAt"))
        if resolved_at is not None and resolved_at > 0:
            skipped["resolved"] += 1
            # Track resolved events to remove from previous data
            # Only mark independent markets (non-child markets) for removal
            if event_id and only_ai_for_new and not is_child_market:
                resolved_event_ids.add(event_id)
            continue

        cutoff = _parse_cutoff_epoch_seconds(market.get("cutoffAt"))
        # If child market has cutoffAt=0, check parent event's cutoffAt
        if cutoff is None or cutoff == 0:
            raw_cutoff = market.get("cutoffAt")
            if raw_cutoff in (0, 0.0, "0", "0.0") and event_id and event_id in parent_events:
                parent_cutoff = _parse_cutoff_epoch_seconds(parent_events[event_id].get("cutoffAt"))
                if parent_cutoff is not None and parent_cutoff > 0:
                    cutoff = parent_cutoff
                    if DEBUG:
                        print(f"[debug] using parent event {event_id} cutoffAt: {cutoff}", flush=True)

        if cutoff is None:
            raw_cutoff = market.get("cutoffAt")
            if raw_cutoff in (0, 0.0, "0", "0.0"):
                skipped["cutoff_zero_kept"] += 1
            else:
                skipped["cutoff_missing_or_invalid"] += 1
                continue
        elif cutoff <= now:
            skipped["cutoff_expired"] += 1
            # Track expired events to remove from previous data
            # Only mark independent markets (non-child markets) for removal
            if event_id and only_ai_for_new and not is_child_market:
                resolved_event_ids.add(event_id)
            continue

        if not market_id:
            skipped["missing_id"] += 1
            continue

        title = _market_title(market)
        if not title:
            skipped["missing_title"] += 1
            continue

        # Filter out markets matching specific title patterns (e.g., incorrect data)
        # "Bitcoin above ... on December XX" markets have wrong cutoffAt (2026 instead of 2025)
        # Check both market title and parent event title for multi-choice markets
        event_title_to_check = parent_event_title or title
        if event_title_to_check.startswith("Bitcoin above ... on "):
            skipped["title_pattern_filtered"] = skipped.get("title_pattern_filtered", 0) + 1
            # Mark these events for removal from previous data
            # Always mark for removal, even for child markets (so parent event gets removed)
            if event_id and only_ai_for_new:
                resolved_event_ids.add(event_id)
            continue

        kept += 1

        event_title = parent_event_title or title
        event_market_id = event_id

        yes_label = market.get("yesLabel")
        no_label = market.get("noLabel")
        volume = _market_volume(market)
        # Treat events as the primary "market" for the extension.
        # Child option markets (e.g. "Team AI") should not become standalone
        # entries in `markets_out`; instead we aggregate to `event_market_id`.
        url = f"{FRONTEND_BASE_URL}/market/{event_market_id}?ref={REF_PARAM}"

        rules_text = _market_rules(market)
        option_title = title if parent_event_title else None

        # Extract token IDs from market data
        yes_token_id = market.get("yesTokenId")
        no_token_id = market.get("noTokenId")

        if event_market_id in markets_out:
            duplicate_event_market_ids += 1
            # Update tokenIds even if market already exists (fix missing tokenIds in old data)
            if yes_token_id:
                markets_out[event_market_id]["yesTokenId"] = yes_token_id
            if no_token_id:
                markets_out[event_market_id]["noTokenId"] = no_token_id
            # Update URL if needed
            if url:
                markets_out[event_market_id]["url"] = url
        else:
            markets_out[event_market_id] = {
                "title": event_title,
                "url": url,
                "yesTokenId": yes_token_id,
                "noTokenId": no_token_id,
                "volume": 0.0,
                "labels": {"yesLabel": None, "noLabel": None},
            }

        event_bucket = event_accumulator.get(event_id)
        if not event_bucket:
            event_bucket = {
                "eventId": event_id,
                "title": event_title,
                "marketIds": [],
                "optionTitles": [],
                "optionTitlesAll": [],
                "optionTitleSeen": set(),
                "rulesBest": "",
                "bestMarketId": market_id,
                "bestMarketVolume": volume,
                "sigCore": None,
                "sigFull": None,
            }
            event_accumulator[event_id] = event_bucket

        event_bucket["marketIds"].append(market_id)
        if option_title:
            if option_title not in event_bucket["optionTitleSeen"]:
                event_bucket["optionTitleSeen"].add(option_title)
                if len(event_bucket["optionTitles"]) < 20:
                    event_bucket["optionTitles"].append(option_title)
                if len(event_bucket["optionTitlesAll"]) < 500:
                    event_bucket["optionTitlesAll"].append(option_title)
        if rules_text and len(rules_text) > len(event_bucket["rulesBest"]):
            event_bucket["rulesBest"] = rules_text
        if volume > event_bucket["bestMarketVolume"]:
            event_bucket["bestMarketId"] = market_id
            event_bucket["bestMarketVolume"] = volume
            event_bucket["bestLabels"] = {"yesLabel": yes_label, "noLabel": no_label}

        # Update aggregated event-level market output.
        if event_market_id in markets_out:
            if not (only_ai_for_new and event_market_id in existing_market_ids):
                markets_out[event_market_id]["volume"] = max(markets_out[event_market_id].get("volume") or 0.0, volume)
                # Prefer labels from the current best-volume option.
                if event_bucket.get("bestMarketId") == market_id:
                    markets_out[event_market_id]["labels"] = {"yesLabel": yes_label, "noLabel": no_label}

    if duplicate_event_market_ids and DEBUG:
        print(
            f"[debug] encountered {duplicate_event_market_ids} repeated event market IDs while building output; "
            f"kept_market_nodes={kept} unique_event_markets={len(markets_out)}",
            flush=True,
        )

    total_events = len(event_accumulator)
    planned_reuse = 0
    planned_llm = 0
    planned_fallback = 0
    for event_id, bucket in event_accumulator.items():
        sig_core = _event_signature_core(bucket.get("title") or event_id, bucket.get("rulesBest") or "")
        sig_full = _event_signature_full(
            event_title=bucket.get("title") or event_id,
            market_ids=bucket.get("marketIds") or [],
            option_titles_all=bucket.get("optionTitlesAll") or bucket.get("optionTitles") or [],
            rules_best=bucket.get("rulesBest") or "",
        )
        bucket["sigCore"] = sig_core
        bucket["sigFull"] = sig_full

        reusable = bool(only_ai_for_new and event_id in existing_event_ids)

        if reusable:
            planned_reuse += 1
        else:
            if not api_key:
                planned_fallback += 1
            else:
                planned_llm += 1

    if total_events:
        print(
            f"[info] events: total={total_events} reuse={planned_reuse} llm={planned_llm} fallback={planned_fallback}",
            flush=True,
        )

    for event_id, bucket in event_accumulator.items():
        if max_events is not None and event_stats["events"] >= max_events:
            break

        # Skip sub-markets that are not true parent events
        # Only process:
        # 1. True parent events (parent_events with multiple sub-markets or different sub-market ID)
        # 2. Independent binary markets (single marketId, not a sub-market of any parent)
        market_ids = bucket.get("marketIds") or []

        # Check if this is a true multi-choice parent event
        is_true_parent_event = False
        if event_id in parent_events:
            parent_data = parent_events[event_id]
            sub_markets = parent_data.get("subMarkets") or []
            # True parent if: multiple sub-markets OR single sub-market with different ID
            if len(sub_markets) > 1:
                is_true_parent_event = True
            elif len(sub_markets) == 1 and sub_markets[0].get("marketId") != event_id:
                is_true_parent_event = True
            # else: single sub-market with same ID = binary market, not a true parent
            elif len(sub_markets) == 1 and sub_markets[0].get("marketId") == event_id:
                # This is a pseudo-parent (binary market wrapped as event), skip it
                pseudo_parent_event_ids.add(event_id)
                if DEBUG:
                    print(f"[debug] skipping pseudo-parent event_id={event_id} title='{bucket.get('title')}' (single sub-market with same ID)", flush=True)
                continue

        # Independent binary market: single marketId, not in parent_events
        is_independent_binary = len(market_ids) == 1 and event_id == market_ids[0] and not is_true_parent_event

        if not (is_true_parent_event or is_independent_binary):
            if DEBUG:
                print(f"[debug] skipping sub-market event_id={event_id} title='{bucket.get('title')}' (not a true parent event or independent binary market)", flush=True)
            continue

        event_stats["events"] += 1
        if event_stats["events"] == 1:
            to_run = min(total_events, max_events) if max_events is not None else total_events
            print(f"[info] processing {to_run} events (from {kept} markets): {planned_reuse} reused, {planned_llm} need LLM", flush=True)
        if event_stats["events"] % 10 == 0:
            print(f"[info] events keyworded: {event_stats['events']}", flush=True)

        rules_text = bucket.get("rulesBest") or ""
        option_titles = bucket.get("optionTitles") or []
        if option_titles:
            options_preview = ", ".join(option_titles[:20])
            rules_text = (rules_text + "\n\nOptions: " + options_preview).strip()

        sig_core = bucket.get("sigCore") or _event_signature_core(bucket.get("title") or event_id, bucket.get("rulesBest") or "")
        sig_full = bucket.get("sigFull") or _event_signature_full(
            event_title=bucket.get("title") or event_id,
            market_ids=bucket.get("marketIds") or [],
            option_titles_all=bucket.get("optionTitlesAll") or option_titles,
            rules_best=bucket.get("rulesBest") or "",
        )

        reused = False
        keywords = []
        entities = []
        entity_groups = []

        if only_ai_for_new and event_id in existing_event_ids:
            # Check if previous event has entityGroups
            prev_entity_groups = prev_events.get(event_id, {}).get("entityGroups") or []
            if prev_entity_groups:
                # Only-AI-for-new mode: keep previous outputs untouched for existing event IDs with entityGroups.
                ai_stats["reused"] += 1
                continue
            else:
                # Previous event exists but has no entityGroups - regenerate with LLM
                ai_stats["regenerated_empty_entitygroups"] += 1
                if DEBUG:
                    print(f"[debug] event={event_id} exists but has empty entityGroups, regenerating with LLM", flush=True)

        # If SKIP_AI is enabled, skip new events (don't generate keywords for them)
        if SKIP_AI and event_id not in existing_event_ids:
            ai_stats["skipped_new"] += 1
            continue

        if not api_key:
            ai_stats["fallback"] += 1
            keywords = _fallback_keywords(bucket.get("title") or event_id, option_titles, rules_text)
            entity_groups = []
            entities = []
        else:
            ai_stats["calls"] += 1
            try:
                title_for_ai = bucket.get("title") or event_id
                best_market_id = bucket.get("bestMarketId")
                best_market_url = (
                    f"{FRONTEND_BASE_URL}/market/{best_market_id}?ref={REF_PARAM}"
                    if best_market_id
                    else None
                )
                allow_terms = {_normalize_keyword(t) for t in _allowed_entity_alias_terms_from_title(title_for_ai)}

                # Skip LLM if SKIP_AI is enabled
                if SKIP_AI:
                    keywords = _fallback_keywords(bucket.get("title") or event_id, option_titles, rules_text)
                    entities = []
                    entity_groups = []
                    ai_stats["fallback"] += 1
                else:
                    safe_title = _truncate(str(title_for_ai or "").strip(), 160)
                    print(f"[info] llm: generating entities/keywords for event={event_id} title={safe_title!r}", flush=True)
                    result = generate_keywords(
                        api_key,
                        title=title_for_ai,
                        rules=rules_text,
                        context={
                            "eventId": event_id,
                            "bestMarketId": best_market_id,
                            "bestMarketUrl": best_market_url,
                        },
                    )
                    if isinstance(result, dict):
                        keywords = result.get("keywords", [])
                        entities = result.get("entities", [])
                        entity_groups = result.get("entityGroups", []) or result.get("entity_groups", [])

                        # Augment with Chinese translations from dictionary
                        keywords, entity_groups = augment_with_chinese(keywords, entities, entity_groups)
                        normalized_try = _normalize_entity_groups(entity_groups, title_for_ai, allow_terms)

                        if not normalized_try:
                            bad_terms = _collect_invalid_entity_terms(entity_groups, entities, title_for_ai, allow_terms)
                            ai_stats["retries"] += 1
                            if bad_terms:
                                print(
                                    f"[warn] llm: retrying once for event={event_id} due to invalid entityGroups; avoid={bad_terms}",
                                    flush=True,
                                )
                            else:
                                print(
                                    f"[warn] llm: retrying once for event={event_id} due to empty/invalid entityGroups",
                                    flush=True,
                                )
                            retry_ctx = {
                                "eventId": event_id,
                                "bestMarketId": best_market_id,
                                "bestMarketUrl": best_market_url,
                            }
                            if bad_terms:
                                retry_ctx["avoidEntityTerms"] = bad_terms
                            retry = generate_keywords(
                                api_key,
                                title=title_for_ai,
                                rules=rules_text,
                                context=retry_ctx,
                            )
                            if isinstance(retry, dict):
                                keywords = retry.get("keywords", keywords)
                                entities = retry.get("entities", entities)
                                entity_groups = retry.get("entityGroups", []) or retry.get("entity_groups", [])

                                # Augment retry result with Chinese translations
                                keywords, entity_groups = augment_with_chinese(keywords, entities, entity_groups)
                    elif isinstance(result, list):
                        # Backwards compatibility with old array format
                        keywords = result
                        entities = []
                        entity_groups = []
            except Exception as exc:
                ai_stats["errors"] += 1
                if DEBUG:
                    print(f"[warn] llm error for event={event_id}: {exc}", flush=True)
                keywords = _fallback_keywords(bucket.get("title") or event_id, option_titles, rules_text)
                entities = []
                entity_groups = []
        if not keywords:
            ai_stats["empty"] += 1
        else:
            ai_stats["non_empty"] += 1

        # Always supplement with deterministic title n-grams so short tweets
        # like "Kraken IPO..." still match even if the LLM returns only longer phrases.
        supplement = _title_ngram_keywords(bucket.get("title") or event_id)
        for s in supplement:
            if s not in keywords:
                keywords.append(s)

        normalized = []
        for kw in keywords:
            nkw = _normalize_keyword(kw)
            if nkw and nkw not in normalized:
                normalized.append(nkw)

        normalized_entities = []
        normalized_entity_groups = []
        allow_terms = {_normalize_keyword(t) for t in _allowed_entity_alias_terms_from_title(bucket.get("title") or event_id)}

        if isinstance(entity_groups, list) and entity_groups:
            for group in entity_groups:
                if not isinstance(group, list):
                    continue
                ng = []
                for term in group:
                    if not isinstance(term, str):
                        continue
                    nterm = _normalize_keyword(term)
                    if not nterm:
                        continue
                    if not _is_valid_entity_term(nterm):
                        continue
                    if not _term_is_from_title(nterm, bucket.get("title") or event_id, allow_terms):
                        continue
                    if nterm not in ng:
                        ng.append(nterm)
                    if len(ng) >= 4:
                        break
                if ng:
                    normalized_entity_groups.append(ng)
                if len(normalized_entity_groups) >= 2:
                    break

        # Backwards compatibility: treat legacy `entities` as AND of singletons.
        if not normalized_entity_groups and isinstance(entities, list) and entities:
            for ent in entities:
                nent = _normalize_keyword(ent)
                if not nent:
                    continue
                if not _is_valid_entity_term(nent):
                    continue
                if not _term_is_from_title(nent, bucket.get("title") or event_id, allow_terms):
                    continue
                normalized_entity_groups.append([nent])
                if len(normalized_entity_groups) >= 2:
                    break

        # Canonical entities (for display/debug): first term of each OR-group.
        seen_entities = set()
        for group in normalized_entity_groups:
            head = group[0] if group else ""
            if head and head not in seen_entities:
                seen_entities.add(head)
                normalized_entities.append(head)

        # Only add true parent events to events_out (not independent binary markets)
        if is_true_parent_event:
            events_out[event_id] = {
                "title": bucket.get("title") or event_id,
                "marketIds": [event_id],
                "bestMarketId": event_id,
                "bestLabels": bucket.get("bestLabels") or None,
                "keywords": normalized,
                "entities": normalized_entities,
                "entityGroups": normalized_entity_groups,
                "sig": sig_full,
                "sigFull": sig_full,
                "sigCore": sig_core,
                "reused": reused,
            }

        if event_id in markets_out:
            markets_out[event_id]["keywords"] = normalized
            markets_out[event_id]["entities"] = normalized_entities
            markets_out[event_id]["entityGroups"] = normalized_entity_groups
            if event_id in events_out and events_out[event_id].get("bestLabels"):
                markets_out[event_id]["labels"] = events_out[event_id]["bestLabels"]

        # Add both keywords and entities to index
        for nkw in normalized:
            event_inverted.setdefault(nkw, set()).add(event_id)
            inverted.setdefault(nkw, set()).add(event_id)

        # Also add entity terms (AND/OR groups) to index so entity-only matching works.
        entity_terms = set()
        for group in normalized_entity_groups:
            for term in group:
                if term:
                    entity_terms.add(term)
        for term in entity_terms:
            event_inverted.setdefault(term, set()).add(event_id)
            inverted.setdefault(term, set()).add(event_id)

        if sleep_seconds > 0 and api_key:
            time.sleep(sleep_seconds)

    # Remove pseudo-parent events (binary markets wrapped as events) from events_out
    # These should only exist in markets_out, not events_out
    if pseudo_parent_event_ids:
        removed_pseudo_count = 0
        for event_id in pseudo_parent_event_ids:
            if event_id in events_out:
                del events_out[event_id]
                removed_pseudo_count += 1
        if removed_pseudo_count > 0:
            print(f"[info] removed {removed_pseudo_count} pseudo-parent events from events output", flush=True)

    # Remove resolved/expired events from output
    if resolved_event_ids:
        removed_count = 0
        for event_id in resolved_event_ids:
            if event_id in events_out:
                del events_out[event_id]
                removed_count += 1
            if event_id in markets_out:
                del markets_out[event_id]
        if removed_count > 0:
            print(f"[info] removed {removed_count} resolved/expired events from output", flush=True)

    # When seeding from previous data, also remove events that are no longer in current API response
    if only_ai_for_new and current_api_event_ids:
        missing_event_ids = set(events_out.keys()) - current_api_event_ids
        if DEBUG:
            print(f"[debug] current_api_event_ids count: {len(current_api_event_ids)}", flush=True)
            print(f"[debug] events_out count: {len(events_out)}", flush=True)
            print(f"[debug] missing_event_ids count: {len(missing_event_ids)}", flush=True)
            if missing_event_ids:
                print(f"[debug] missing_event_ids sample: {sorted(list(missing_event_ids))[:10]}", flush=True)
        if missing_event_ids:
            missing_count = 0
            for event_id in missing_event_ids:
                if event_id in events_out:
                    del events_out[event_id]
                    missing_count += 1
                if event_id in markets_out:
                    del markets_out[event_id]
            if missing_count > 0:
                print(f"[info] removed {missing_count} events no longer in API response", flush=True)

    index_out = {kw: sorted(list(ids)) for kw, ids in sorted(inverted.items(), key=lambda kv: kv[0])}
    event_index_out = {kw: sorted(list(ids)) for kw, ids in sorted(event_inverted.items(), key=lambda kv: kv[0])}

    if only_ai_for_new:
        # Rebuild event index from events_out (multi-choice events only)
        event_rebuilt = {}
        for eid, e in events_out.items():
            if not isinstance(e, dict):
                continue
            kws = e.get("keywords")
            if isinstance(kws, list):
                for kw in kws:
                    nkw = _normalize_keyword(kw)
                    if nkw:
                        event_rebuilt.setdefault(nkw, set()).add(eid)
            groups = e.get("entityGroups") or e.get("entity_groups")
            if isinstance(groups, list):
                for group in groups:
                    if not isinstance(group, list):
                        continue
                    for term in group:
                        nterm = _normalize_keyword(term)
                        if nterm:
                            event_rebuilt.setdefault(nterm, set()).add(eid)
        event_index_out = {kw: sorted(list(ids)) for kw, ids in sorted(event_rebuilt.items(), key=lambda kv: kv[0])}

        # Rebuild market index from ALL markets (including binary markets not in events_out)
        market_rebuilt = {}
        for mid, m in markets_out.items():
            if not isinstance(m, dict):
                continue
            kws = m.get("keywords")
            if isinstance(kws, list):
                for kw in kws:
                    nkw = _normalize_keyword(kw)
                    if nkw:
                        market_rebuilt.setdefault(nkw, set()).add(mid)
            groups = m.get("entityGroups") or m.get("entity_groups")
            if isinstance(groups, list):
                for group in groups:
                    if not isinstance(group, list):
                        continue
                    for term in group:
                        nterm = _normalize_keyword(term)
                        if nterm:
                            market_rebuilt.setdefault(nterm, set()).add(mid)
        index_out = {kw: sorted(list(ids)) for kw, ids in sorted(market_rebuilt.items(), key=lambda kv: kv[0])}

    # Process multi-choice markets: add type and subMarkets fields
    multi_market_count = 0
    for market_id, market_data in markets_out.items():
        if not isinstance(market_data, dict):
            continue

        # Check if this market is a multi-choice market (has multiple subMarkets in parent_events)
        parent_event_data = parent_events.get(market_id) if parent_events else None
        if parent_event_data and isinstance(parent_event_data, dict):
            sub_markets_data = parent_event_data.get("subMarkets")
            if sub_markets_data and isinstance(sub_markets_data, list):
                # Only mark as multi-choice if there are multiple sub-markets
                # Single sub-market with same marketId as eventId = binary market
                if len(sub_markets_data) > 1:
                    # Multiple sub-markets = true multi-choice market
                    market_data["type"] = "multi"
                    market_data["subMarkets"] = sub_markets_data
                    multi_market_count += 1
                elif len(sub_markets_data) == 1 and sub_markets_data[0].get("marketId") != market_id:
                    # Single sub-market but different ID = also multi-choice
                    market_data["type"] = "multi"
                    market_data["subMarkets"] = sub_markets_data
                    multi_market_count += 1
                # else: Single sub-market with same ID = binary market, don't add type/subMarkets

    if multi_market_count > 0 and DEBUG:
        print(f"[debug] processed {multi_market_count} multi-choice markets with subMarkets", flush=True)

    # Mark remaining markets as binary (those without type field)
    binary_market_count = 0
    for market_id, market_data in markets_out.items():
        if not isinstance(market_data, dict):
            continue
        if "type" not in market_data or market_data.get("type") is None:
            market_data["type"] = "binary"
            binary_market_count += 1

    if binary_market_count > 0 and DEBUG:
        print(f"[debug] marked {binary_market_count} binary markets with type='binary'", flush=True)

    # Data integrity validation
    validation_errors = []
    for market_id, market_data in markets_out.items():
        if not isinstance(market_data, dict):
            continue

        market_type = market_data.get("type")
        if market_type == "multi":
            # Multi-choice market must have subMarkets
            sub_markets = market_data.get("subMarkets")
            if not sub_markets or not isinstance(sub_markets, list) or len(sub_markets) == 0:
                validation_errors.append(f"Multi-choice market {market_id} missing or empty subMarkets")
            else:
                # Validate each sub-market
                for i, sub_market in enumerate(sub_markets):
                    if not isinstance(sub_market, dict):
                        continue
                    sub_market_id = sub_market.get("marketId")
                    yes_token_id = sub_market.get("yesTokenId")
                    if not yes_token_id:
                        validation_errors.append(
                            f"Sub-market {i} of market {market_id} (sub_market_id={sub_market_id}) missing yesTokenId"
                        )
        else:
            # Binary market should have yesTokenId and noTokenId
            # Note: We use a warning instead of error since some markets might legitimately not have tokenIds
            yes_token_id = market_data.get("yesTokenId")
            no_token_id = market_data.get("noTokenId")
            if not yes_token_id or not no_token_id:
                if DEBUG:
                    print(
                        f"[debug] binary market {market_id} missing tokenIds: yesTokenId={yes_token_id}, noTokenId={no_token_id}",
                        flush=True,
                    )

    if validation_errors:
        print(f"[warn] data validation found {len(validation_errors)} errors:", flush=True)
        for error in validation_errors[:10]:  # Show first 10 errors
            print(f"  - {error}", flush=True)
        if len(validation_errors) > 10:
            print(f"  ... and {len(validation_errors) - 10} more errors", flush=True)

    return {
        "meta": {
            "generatedAt": _format_utc8_time(now),
            "source": OPINION_API_URL,
            "frontendBaseUrl": FRONTEND_BASE_URL,
            "model": MODEL_NAME,
            "ref": REF_PARAM,
            "debug": DEBUG,
                "counts": {
                    "seen": processed,
                    "kept": kept,
                    "markets": len(markets_out),
                    "keywords": len(index_out),
                    "events": event_stats,
                    "skipped": skipped,
                    "ai": ai_stats,
            },
        },
        "events": events_out,
        "markets": markets_out,
        "index": index_out,
        "eventIndex": event_index_out,
    }


def main():
    print("[info] starting build_index", flush=True)
    # 已在环境变量中配置
    api_key = os.environ.get("ZHIPU_KEY")
    if FULL_AI_REFRESH and not api_key:
        print("[error] FULL_AI_REFRESH=1 requires ZHIPU_KEY.", flush=True)
        raise ValueError("ZHIPU_KEY is not set")
    if not api_key:
        print("[warn] ZHIPU_KEY not set: new events will use deterministic fallback keywords.", flush=True)

    # Default output path: project root directory (one level up from backend/)
    output_path = os.environ.get("OUTPUT_PATH") or os.path.join(os.path.dirname(os.path.dirname(__file__)), "data.json")

    if SKIP_AI:
        print("[info] mode: SKIP_AI=1 (no LLM calls, using fallback keywords only)", flush=True)
    elif FULL_AI_REFRESH:
        print("[info] mode: FULL_AI_REFRESH=1 (LLM for all events)", flush=True)
    else:
        print("[info] mode: FULL_AI_REFRESH=0 (LLM only for new events)", flush=True)

    if DEBUG:
        print(
            "[debug] env MAX_MARKETS=%r SLEEP_SECONDS=%r OUTPUT_PATH=%r"
            % (os.environ.get("MAX_MARKETS"), os.environ.get("SLEEP_SECONDS"), os.environ.get("OUTPUT_PATH")),
            flush=True,
        )
        print(f"[debug] FULL_AI_REFRESH={FULL_AI_REFRESH}", flush=True)
        print(
            "[debug] ZHIPU_TIMEOUT_SECONDS=%s ZHIPU_MAX_RETRIES=%s"
            % (ZHIPU_TIMEOUT_SECONDS, ZHIPU_MAX_RETRIES),
            flush=True,
        )

    print("[info] fetching markets...", flush=True)
    markets = fetch_all_markets()
    print(f"[info] fetched {len(markets)} market nodes (including parents)", flush=True)

    print("[info] fetching parent events for cutoff validation...", flush=True)
    parent_events = fetch_parent_events()

    previous_data = _load_previous_data(os.path.join(os.path.dirname(os.path.dirname(__file__)), "data.json"))
    if previous_data is not None:
        print("[info] loaded previous data for reuse", flush=True)
    data = build_data(markets, api_key=api_key, previous_data=previous_data, parent_events=parent_events)

    output_dir = os.path.dirname(output_path)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"[info] wrote {output_path}", flush=True)


if __name__ == "__main__":
    main()
