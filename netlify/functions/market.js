// 경제지표 프록시 (After10 일지용)
// 소스: Yahoo Finance chart API (서버측 호출 → CORS 무관)
// 쿼리: ?date=YYYY-MM-DD → 그 날짜의(없으면 직전 거래일) 지표 7종 반환
//
// ⚠️ 소스가 막히면 아래 SOURCE / SYMBOLS / fetchOne 만 교체하면 된다.

const SOURCE = "yahoo";

// 저장/표시 키 → Yahoo 심볼 (2024 데이터로 유효성 확인 완료)
const SYMBOLS = {
  usdkrw: "KRW=X",     // 원/달러
  jpykrw: "JPYKRW=X",  // 원/엔
  spx:    "^GSPC",     // S&P500
  ndq:    "^IXIC",     // 나스닥
  kospi:  "^KS11",     // 코스피
  gold:   "GC=F",      // 금 (USD/oz)
  btc:    "BTC-USD",   // 비트코인 (USD)
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const DAY = 24 * 3600;

function toEpoch(dateStr) {           // YYYY-MM-DD → epoch(초, UTC 자정)
  return Math.floor(Date.parse(dateStr + "T00:00:00Z") / 1000);
}
function epochToYmd(sec) {             // epoch(초) → YYYY-MM-DD (UTC)
  const d = new Date(sec * 1000);
  const p = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

// 값 반올림 (지표별)
function roundVal(key, v) {
  if (v == null || Number.isNaN(v)) return null;
  if (key === "btc") return Math.round(v);            // 비트코인은 정수
  return Math.round(v * 100) / 100;                   // 나머지 소수 2자리
}

// 한 심볼의 '요청일 이하 마지막 거래일 종가' 조회
async function fetchOne(yahooSym, targetEpoch) {
  const period1 = targetEpoch - 14 * DAY;   // 넉넉히 14일 전부터 (연휴 대비)
  const period2 = targetEpoch + DAY;        // 요청일 포함
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}` +
              `?period1=${period1}&period2=${period2}&interval=1d`;

  // 요청별 타임아웃 6초: 한 심볼이 늘어져도 함수 전체가 Netlify 한도(10초)를
  // 넘겨 502가 되는 것을 막고, 그 심볼만 실패로 처리한다.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  const r = data && data.chart && data.chart.result && data.chart.result[0];
  const ts = r && r.timestamp;
  const closes = r && r.indicators && r.indicators.quote && r.indicators.quote[0] &&
                 r.indicators.quote[0].close;
  if (!ts || !closes) throw new Error("no data");

  // 요청일(그 날 끝) 이하에서 종가가 있는 마지막 인덱스 선택
  const cutoff = targetEpoch + DAY;
  let picked = -1;
  for (let i = 0; i < ts.length; i++) {
    if (ts[i] < cutoff && closes[i] != null) picked = i;
  }
  if (picked === -1) throw new Error("no close in range");

  return { value: closes[picked], basisEpoch: ts[picked] };
}

exports.handler = async (event) => {
  const date = (event.queryStringParameters && event.queryStringParameters.date) || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { statusCode: 400, body: JSON.stringify({ error: "date=YYYY-MM-DD 필요" }) };
  }
  const targetEpoch = toEpoch(date);

  const keys = Object.keys(SYMBOLS);
  // 병렬 조회 — 일부 실패해도 나머지는 유지 (전체 실패 처리 금지)
  const settled = await Promise.allSettled(
    keys.map(k => fetchOne(SYMBOLS[k], targetEpoch))
  );

  const market = { source: SOURCE, requestedDate: date };
  const errors = {};
  // 대표 기준일 = 가장 오래된(=직전 거래일) 기준일.
  // 비트코인 등 주말에도 거래되는 지표가 섞여도, 주식·환율이 직전 거래일로
  // 폴백되면 그 날짜가 대표 기준일이 되어 stale이 올바르게 표시된다.
  let basisEpochMin = null;

  settled.forEach((res, i) => {
    const k = keys[i];
    if (res.status === "fulfilled") {
      market[k] = roundVal(k, res.value.value);
      if (basisEpochMin == null || res.value.basisEpoch < basisEpochMin) {
        basisEpochMin = res.value.basisEpoch;
      }
    } else {
      errors[k] = String((res.reason && res.reason.message) || res.reason);
    }
  });

  market.basisDate = basisEpochMin ? epochToYmd(basisEpochMin) : date;
  // 요청일과 기준일이 다르면(주말/공휴일 등 직전 거래일 사용) 표시
  market.stale = market.basisDate !== date;
  if (Object.keys(errors).length) market.errors = errors;

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
    body: JSON.stringify(market),
  };
};
