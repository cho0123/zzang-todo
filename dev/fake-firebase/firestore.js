/* 검증용 가짜 Firestore.
   firebase-firestore.js 자리에 끼워 넣어, 공유 실데이터에 닿지 않고 저장 경로까지 확인한다.
   쓰는 법과 한계는 같은 폴더의 README.md 참고. 배포에는 들어가지 않는다(publish = "public").

   ⚠ 재현하는 규칙 — setDoc/updateDoc 의 merge 에 빈 맵 {} 을 보내면 그 자리를 덮어쓴다.
     실제로 2026-09-24 에 이 방식으로 저장된 값이 사라졌다. 빈 맵이 들어오면 store 에
     그대로 반영하고(= 지워지고) window.__fsViolations 에 남겨, 테스트가 잡아낼 수 있게 한다. */

const store = (typeof window !== 'undefined' && window.__fsSeed) ? window.__fsSeed : {};
const log = [];
let nextId = 1;

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

const DELETE = { __sentinel: 'delete' };
function isSentinel(v) { return v && typeof v === 'object' && v.__sentinel; }

function mergeInto(dst, patch, path, viol) {
    Object.keys(patch).forEach(k => {
        const v = patch[k], pth = path ? path + '.' + k : k;
        if (isSentinel(v)) {
            if (v.__sentinel === 'delete') { delete dst[k]; return; }
            const cur = Array.isArray(dst[k]) ? dst[k].slice() : [];
            if (v.__sentinel === 'union') v.vals.forEach(x => { if (cur.indexOf(x) < 0) cur.push(x); });
            if (v.__sentinel === 'remove') v.vals.forEach(x => { const i = cur.indexOf(x); if (i >= 0) cur.splice(i, 1); });
            dst[k] = cur; return;
        }
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            if (Object.keys(v).length === 0) {            // ⚠ 빈 맵 = 그 자리를 덮어쓴다
                viol.push('EMPTY-MAP at ' + pth);
                dst[k] = {}; return;
            }
            if (!dst[k] || typeof dst[k] !== 'object' || Array.isArray(dst[k])) dst[k] = {};
            mergeInto(dst[k], v, pth, viol); return;
        }
        dst[k] = v;
    });
}

// firebase-app.js 의 initializeApp 도 여기서 함께 내보낸다(세 모듈을 한 파일로 끼워도 되게)
export function initializeApp() { return {}; }
export function getFirestore() { return { __db: true }; }
export function collection(db, name) { return { __col: name }; }
export function doc(a, b, c) {
    if (a && a.__col) return { __col: a.__col, __id: b };      // doc(colRef, id)
    return { __col: b, __id: c };                              // doc(db, name, id)
}
/* query/where 는 모양만 맞춘다 — 걸러내지 않고 컬렉션 전체를 돌려준다.
   이 앱은 문서 id로 찾고 컬렉션을 통째로 읽는 방식이라 아직 걸러낼 일이 없었다.
   조건 조회를 검증해야 할 때가 오면 getDocs 에서 where 를 실제로 적용할 것. */
export function query(col) { return col; }
export function where(f, op, v) { return { f, op, v }; }
export function deleteField() { return DELETE; }
export function arrayUnion(...vals) { return { __sentinel: 'union', vals }; }
export function arrayRemove(...vals) { return { __sentinel: 'remove', vals }; }

function colDocs(col) {
    const c = store[col.__col] || {};
    return Object.keys(c).map(id => ({
        id, exists: () => true, data: () => clone(c[id]),
    }));
}

export async function getDocs(col) {
    const rows = colDocs(col);
    return { forEach: cb => rows.forEach(cb), docs: rows, size: rows.length, empty: !rows.length };
}
export async function getDoc(ref) {
    const v = (store[ref.__col] || {})[ref.__id];
    return { id: ref.__id, exists: () => v !== undefined, data: () => clone(v) };
}
export async function setDoc(ref, data, opts) {
    if (window.__fsFail) throw new Error('permission-denied (가짜 Firestore: 실패 시험)');
    const viol = [];
    const c = store[ref.__col] || (store[ref.__col] = {});
    if (opts && opts.merge) {
        if (!c[ref.__id]) c[ref.__id] = {};
        mergeInto(c[ref.__id], clone(data), '', viol);
    } else {
        c[ref.__id] = clone(data);
    }
    log.push({ op: 'setDoc', col: ref.__col, id: ref.__id, data: clone(data),
               merge: !!(opts && opts.merge), violations: viol });
    if (viol.length) window.__fsViolations.push(...viol);
}
export async function updateDoc(ref, data) {
    if (window.__fsFail) throw new Error('permission-denied (가짜 Firestore: 실패 시험)');
    const viol = [];
    const c = store[ref.__col] || (store[ref.__col] = {});
    if (!c[ref.__id]) c[ref.__id] = {};
    mergeInto(c[ref.__id], clone(data), '', viol);
    log.push({ op: 'updateDoc', col: ref.__col, id: ref.__id, data: clone(data), violations: viol });
    if (viol.length) window.__fsViolations.push(...viol);
}
export async function addDoc(col, data) {
    if (window.__fsFail) throw new Error('permission-denied (가짜 Firestore: 실패 시험)');
    const id = 'fake' + (nextId++);
    (store[col.__col] || (store[col.__col] = {}))[id] = clone(data);
    log.push({ op: 'addDoc', col: col.__col, id, data: clone(data) });
    return { id };
}
export async function deleteDoc(ref) {
    if (window.__fsFail) throw new Error('permission-denied (가짜 Firestore: 실패 시험)');
    delete (store[ref.__col] || {})[ref.__id];
    log.push({ op: 'deleteDoc', col: ref.__col, id: ref.__id });
}
// 구독은 한 번만 흘려보낸다. 이후 변경은 다시 알리지 않는다(필요해지면 여기서 늘릴 것).
export function onSnapshot(col, cb) {
    setTimeout(() => cb({ forEach: f => colDocs(col).forEach(f), docs: colDocs(col) }), 0);
    return () => {};
}

window.__fsViolations = [];
window.__fs = {
    store: () => clone(store),          // 지금 저장돼 있는 것
    log: () => clone(log),              // 어떤 쓰기를 어떤 내용으로 보냈나
    clearLog: () => { log.length = 0; },
    violations: () => window.__fsViolations.slice(),   // 빈 맵으로 덮어쓴 자리
};
