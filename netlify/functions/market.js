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

// 한 심볼의 시계열(요청일 이하, 종가가 있는 날들) 반환.
// 반환: [{ ymd:"YYYY-MM-DD", close:number }, ...] 오름차순
async function fetchSeries(yahooSym, targetEpoch) {
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

  // 요청일(그 날 끝) 이하에서 종가가 있는 날만 (UTC 날짜로 비교해 심볼 간 타임존 차이 제거)
  const cutoff = targetEpoch + DAY;
  const points = [];
  for (let i = 0; i < ts.length; i++) {
    if (ts[i] < cutoff && closes[i] != null) {
      points.push({ ymd: epochToYmd(ts[i]), close: closes[i] });
    }
  }
  if (!points.length) throw new Error("no close in range");
  return points;
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
    keys.map(k => fetchSeries(SYMBOLS[k], targetEpoch))
  );

  // v:2 — 모든 값이 '하나의 공통 기준일'에서 오도록 통일한 포맷 (기존 데이터엔 이 필드가 없음)
  const market = { source: SOURCE, v: 2, requestedDate: date };
  const errors = {};

  // 1단계: 각 심볼의 시계열 확보 + '공통 기준일' 확정.
  // 공통 기준일 = 모든 심볼이 데이터를 가진 마지막 거래일 = 각 심볼 마지막날의 최솟값(min).
  const seriesByKey = {};
  let basisDate = null;
  settled.forEach((res, i) => {
    const k = keys[i];
    if (res.status === "fulfilled") {
      seriesByKey[k] = res.value;
      const lastYmd = res.value[res.value.length - 1].ymd;
      if (basisDate == null || lastYmd < basisDate) basisDate = lastYmd;
    } else {
      errors[k] = String((res.reason && res.reason.message) || res.reason);
    }
  });

  // 2단계: 모든 심볼 값을 '공통 기준일 이하 마지막 종가'로 재선택 → 전 값이 같은 날짜.
  if (basisDate) {
    for (const k of Object.keys(seriesByKey)) {
      let chosen = null;
      for (const p of seriesByKey[k]) {
        if (p.ymd <= basisDate) chosen = p;
      }
      if (chosen) market[k] = roundVal(k, chosen.close);
      else errors[k] = `기준일(${basisDate}) 이전 데이터 없음`;
    }
  }

  market.basisDate = basisDate || date;
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
