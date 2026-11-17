# 가짜 Firebase (검증용)

`public/index.html`을 브라우저에서 돌려볼 때, Firebase 자리에 끼워 넣는 가짜 모듈입니다.

Firestore는 **짱구 Manager와 다른 앱들이 함께 쓰는 실데이터**입니다. 로컬에서 그대로 열면
테스트로 만든 곡·기구·메모가 진짜 데이터에 섞이고, 지우기 전까지 남습니다. 이 모듈을 끼우면
읽기도 쓰기도 전부 메모리 안에서 끝나므로 실데이터에 **닿지 않습니다.**

앱 코드는 이 모듈을 참조하지 않습니다. 검증할 때 복사본의 import 주소만 바꿔 끼웁니다.

## 쓰는 법

**원본을 고치지 마세요.** `public/index.html`을 다른 곳(스크래치패드 등)에 복사한 뒤,
그 복사본에서 import 세 줄의 주소만 바꿉니다.

```
https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js        →  ./firestore.js
https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js  →  ./firestore.js
https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js       →  ./auth.js
```

(`initializeApp`도 `firestore.js`가 함께 내보내므로 app 모듈도 같은 파일을 가리키면 됩니다.)

그 복사본 옆에 이 폴더의 `firestore.js`와 `auth.js`를 같이 두고, 정적 서버로 엽니다.

```bash
python -m http.server 8800
```

### 데이터 심기

모듈 스크립트보다 **먼저** 도는 보통 `<script>`에서 `window.__fsSeed`에 넣습니다.
컬렉션 → 문서 id → 문서 내용 구조입니다.

```html
<script>
window.__fsSeed = {
  lyrics: {
    s1: { title: '첫 곡', body: '[Verse 1]\n...', active: true, updatedAt: 3000 }
  },
  marketDaily: {
    '2026-10': { month: '2026-10', days: { '15': { usdkrw: 1340.5 } }, filled: {}, fetched: {} }
  }
};
</script>
<script type="module"> ... </script>
```

### 확인하기

브라우저 콘솔(또는 자동화 스크립트)에서:

| 부르는 것 | 돌려주는 것 |
|---|---|
| `__fs.store()` | 지금 저장돼 있는 전체 |
| `__fs.log()` | 어떤 쓰기를 어떤 내용으로 보냈나 (op·컬렉션·id·data·merge 여부) |
| `__fs.clearLog()` | 로그 비우기 |
| `__fs.violations()` | 빈 맵으로 덮어쓴 자리 (아래 규칙 참고) |
| `window.__fsFail = true` | 이후 모든 쓰기가 실패 — 저장 실패 경로를 시험할 때 |

## 재현하는 규칙

### 빈 맵 merge = 덮어쓰기

`setDoc(ref, { days: { "19": {} } }, { merge: true })`를 보내면 Firestore는 `days.19`를
**빈 맵으로 바꿉니다.** 그 아래 있던 값은 사라집니다. 2026-09-24에 `marketDaily`에서 실제로
이 방식으로 데이터가 날아갔습니다.

가짜 모듈도 똑같이 덮어쓰되, 그 자리를 `__fs.violations()`에 남깁니다. 테스트에서
`__fs.violations()`가 비어 있는지 확인하면 이 사고를 미리 잡을 수 있습니다.

**받은 값이 없는 달·날짜에는 아예 쓰기를 보내지 않는 것**이 앱 쪽의 규칙입니다.

### merge 의 뜻

- `{ merge: true }` → 보낸 필드만 갈아끼우고 나머지는 둡니다 (중첩 맵은 재귀적으로).
- `merge` 없이 `setDoc` → 문서를 통째로 갈아끼웁니다.
- `updateDoc` → merge와 같게 다룹니다.
- `deleteField()` / `arrayUnion()` / `arrayRemove()` → 실제 동작대로 처리합니다.

## 한계

실제 Firestore를 흉내 낸 것이지 똑같지는 않습니다. 아래는 아직 다르므로, 이것에 기대는
동작을 검증할 때는 먼저 여기부터 손봐야 합니다.

- **`query`/`where`가 걸러내지 않습니다.** 모양만 맞추고 컬렉션 전체를 돌려줍니다.
  (이 앱은 문서 id로 찾고 컬렉션을 통째로 읽는 방식이라 아직 걸림돌이 없었습니다.)
- **`onSnapshot`은 한 번만 흘려보냅니다.** 그 뒤의 변경은 다시 알리지 않습니다.
- **보안 규칙이 없습니다.** 규칙 때문에 막히는 상황은 `window.__fsFail`로만 흉내 냅니다.
- 서버 시각(`serverTimestamp`), 트랜잭션, 배치 쓰기는 없습니다.

## 배포

`netlify.toml`의 `publish = "public"`이라 Netlify는 `public/` 폴더만 올립니다.
이 폴더는 `public/` 밖이므로 배포에 들어가지 않습니다. `netlify/functions`에서도 참조하지
않습니다. `public/index.html`을 포함한 앱 코드 어디에서도 이 모듈을 import하지 않습니다.
