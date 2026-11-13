window.__ModuleLoader__.load({
  id: "dsh-platform-balance",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");

    // ---------------------------------------------------------------------
    // Contract with the host half (lib/index.js)
    // ---------------------------------------------------------------------
    const API_ROOT = "/api/platform-balance";
    const POLL_OVERVIEW_MS = 60_000;
    const POLL_SESSION_MS = 30_000;
    const STORAGE_COLLAPSED = "dsh-platform-balance:collapsed";
    const STYLES_MARKER = "data-dsh-platform-balance";

    // ---------------------------------------------------------------------
    // Formatting (Russian UI copy, ru-RU number formatting)
    // ---------------------------------------------------------------------
    const amountFormat = new Intl.NumberFormat("ru-RU", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const rateFormat = new Intl.NumberFormat("ru-RU", {
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    });
    const countFormat = new Intl.NumberFormat("ru-RU");

    function pad2(value) {
      return value < 10 ? `0${value}` : String(value);
    }

    function currencySymbol(currency) {
      if (currency === "CNY") return "¥";
      if (currency === "USD") return "$";
      if (currency === "EUR") return "€";
      return `${currency} `;
    }

    function formatAmount(currency, value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return "—";
      return `${currencySymbol(currency)}${amountFormat.format(number)}`;
    }

    function formatRub(value) {
      const number = Number(value);
      if (value === null || value === undefined || !Number.isFinite(number)) return "— ₽";
      return `${amountFormat.format(number)} ₽`;
    }

    function formatRate(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return "—";
      return rateFormat.format(number);
    }

    function formatClock(ms) {
      const time = Number(ms);
      if (!Number.isFinite(time)) return "—";
      const date = new Date(time);
      return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    }

    function formatTokens(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return "—";
      return countFormat.format(Math.round(number));
    }

    // ---------------------------------------------------------------------
    // Snapshot stores fed by HTTP polling. The plugin keeps them outside React
    // so the floating card and the header pill share one request stream.
    // ---------------------------------------------------------------------
    let overviewState = null;
    let overviewInflight = null;
    const overviewListeners = new Set();

    const sessionStates = new Map();
    const sessionInflight = new Map();
    const sessionListeners = new Map();

    function notify(listeners) {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // A broken listener must not take the others down.
        }
      }
    }

    function getJson(path) {
      return fetch(path, {
        method: "GET",
        headers: { accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      }).then(
        (response) =>
          response
            .json()
            .catch(() => null)
            .then((payload) => {
              if (payload !== null && typeof payload === "object") return payload;
              return { ok: false, error: `Ответ без JSON (HTTP ${response.status})` };
            }),
        (err) => ({ ok: false, error: `Сеть недоступна: ${err?.message ?? err}` }),
      );
    }

    function readCollapsed() {
      try {
        return localStorage.getItem(STORAGE_COLLAPSED) === "1";
      } catch {
        return false;
      }
    }

    function writeCollapsed(value) {
      try {
        localStorage.setItem(STORAGE_COLLAPSED, value ? "1" : "0");
      } catch {
        // Private mode may refuse storage; the session keeps working in memory.
      }
    }

    let collapsedState = readCollapsed();
    const collapsedListeners = new Set();

    function setCollapsed(value) {
      if (collapsedState === value) return;
      collapsedState = value;
      writeCollapsed(value);
      notify(collapsedListeners);
    }

    function useCollapsed() {
      const [collapsed, setLocal] = React.useState(() => collapsedState);
      React.useEffect(() => {
        const update = () => setLocal(collapsedState);
        collapsedListeners.add(update);
        update();
        return () => collapsedListeners.delete(update);
      }, []);
      return collapsed;
    }

    function loadOverview(force) {
      if (overviewInflight !== null) return overviewInflight;
      overviewState = {
        data: overviewState?.data ?? null,
        error: overviewState?.error ?? null,
        at: overviewState?.at ?? 0,
        loading: true,
      };
      notify(overviewListeners);
      const task = getJson(`${API_ROOT}/overview${force === true ? "?refresh=1" : ""}`)
        .then((payload) => {
          if (payload.ok === true) overviewState = { data: payload.data, error: null, at: Date.now(), loading: false };
          else overviewState = { ...overviewState, error: payload.error ?? "Не удалось получить данные", loading: false };
        })
        .catch((err) => {
          overviewState = { ...overviewState, error: String(err?.message ?? err), loading: false };
        })
        .finally(() => {
          overviewInflight = null;
          notify(overviewListeners);
        });
      overviewInflight = task;
      return task;
    }

    function loadSession(sessionId, force) {
      if (typeof sessionId !== "string" || sessionId === "") return Promise.resolve();
      const running = sessionInflight.get(sessionId);
      if (running !== undefined) return running;
      const previous = sessionStates.get(sessionId) ?? null;
      sessionStates.set(sessionId, {
        data: previous?.data ?? null,
        error: previous?.error ?? null,
        at: previous?.at ?? 0,
        loading: true,
      });
      notify(sessionListeners.get(sessionId) ?? new Set());
      const task = getJson(`${API_ROOT}/session?id=${encodeURIComponent(sessionId)}${force === true ? "&refresh=1" : ""}`)
        .then((payload) => {
          if (payload.ok === true) sessionStates.set(sessionId, { data: payload.data, error: null, at: Date.now(), loading: false });
          else {
            sessionStates.set(sessionId, {
              ...sessionStates.get(sessionId),
              error: payload.error ?? "Не удалось посчитать расход сессии",
              loading: false,
            });
          }
        })
        .catch((err) => {
          sessionStates.set(sessionId, {
            ...sessionStates.get(sessionId),
            error: String(err?.message ?? err),
            loading: false,
          });
        })
        .finally(() => {
          sessionInflight.delete(sessionId);
          notify(sessionListeners.get(sessionId) ?? new Set());
        });
      sessionInflight.set(sessionId, task);
      return task;
    }

    function useOverview(intervalMs) {
      const [snapshot, setSnapshot] = React.useState(() => overviewState);
      React.useEffect(() => {
        const update = () => setSnapshot(overviewState);
        overviewListeners.add(update);
        update();
        void loadOverview(false);
        const timer = setInterval(() => {
          if (typeof document !== "undefined" && document.hidden) return;
          void loadOverview(false);
        }, intervalMs);
        return () => {
          overviewListeners.delete(update);
          clearInterval(timer);
        };
      }, [intervalMs]);
      return snapshot;
    }

    function useSessionSpend(sessionId, intervalMs) {
      const [snapshot, setSnapshot] = React.useState(() => (typeof sessionId === "string" ? sessionStates.get(sessionId) ?? null : null));
      React.useEffect(() => {
        if (typeof sessionId !== "string" || sessionId === "") {
          setSnapshot(null);
          return undefined;
        }
        let listeners = sessionListeners.get(sessionId);
        if (listeners === undefined) {
          listeners = new Set();
          sessionListeners.set(sessionId, listeners);
        }
        const update = () => setSnapshot(sessionStates.get(sessionId) ?? null);
        listeners.add(update);
        update();
        void loadSession(sessionId, false);
        const timer = setInterval(() => {
          if (typeof document !== "undefined" && document.hidden) return;
          void loadSession(sessionId, false);
        }, intervalMs);
        return () => {
          listeners.delete(update);
          clearInterval(timer);
        };
      }, [sessionId, intervalMs]);
      return snapshot;
    }

    /** Resolve the session whose conversation is currently on screen. */
    function currentSessionIdOf(state) {
      const rows = state?.byId ?? {};
      for (const row of Object.values(rows)) {
        if ((row?.retainedBy?.mainView ?? 0) > 0 && typeof row?.id === "string") return row.id;
      }
      return typeof state?.current === "string" ? state.current : undefined;
    }

    // ---------------------------------------------------------------------
    // View components
    // ---------------------------------------------------------------------
    function Row(props) {
      return jsxs("div", {
        className: "dpb-row",
        title: props.title,
        children: [
          jsx("span", { className: "dpb-row-label", children: props.label }),
          jsx("span", { className: props.strong === true ? "dpb-row-value dpb-strong" : "dpb-row-value", children: props.value }),
        ],
      });
    }

    function BalanceBlock(props) {
      const balance = props.balance;
      if (balance === undefined || balance === null) return jsx("div", { className: "dpb-muted", children: "Баланс: загрузка…" });
      if (balance.error !== undefined && balance.error !== null) {
        return jsx("div", { className: "dpb-error", children: balance.error });
      }
      const wallets = Array.isArray(balance.wallets) ? balance.wallets : [];
      return jsxs("div", {
        children: [
          wallets.length === 0
            ? jsx("div", { className: "dpb-muted", children: "Кошельки не найдены" })
            : jsxs("div", {
                children: wallets.map((wallet) =>
                  jsx(
                    Row,
                    {
                      label: formatAmount(wallet.currency, wallet.total),
                      value: `≈ ${formatRub(wallet.rub)}`,
                      title: `Пополнено: ${formatAmount(wallet.currency, wallet.toppedUp)} · Бонусы: ${formatAmount(wallet.currency, wallet.granted)}`,
                    },
                    wallet.currency,
                  ),
                ),
              }),
          jsx(Row, { label: "Итого", value: `≈ ${formatRub(balance.totalRub)}`, strong: true }),
          jsx("div", {
            className: "dpb-source",
            children: balance.source === "account" ? "источник: аккаунт DeepSeek" : "источник: DEEPSEEK_API_KEY",
          }),
        ],
      });
    }

    function CbrBlock(props) {
      const cbr = props.cbr;
      if (cbr === undefined || cbr === null) return jsx("div", { className: "dpb-muted", children: "Курс ЦБ: загрузка…" });
      const rates = cbr.rates ?? null;
      const hasRates = rates !== null && typeof rates === "object" && Number.isFinite(Number(rates.USD)) && Number.isFinite(Number(rates.CNY));
      if (!hasRates) {
        return jsx("div", { className: "dpb-error", children: cbr.error !== undefined && cbr.error !== null ? cbr.error : "Курс ЦБ недоступен" });
      }
      const metaParts = [];
      if (cbr.date !== null && cbr.date !== undefined) metaParts.push(`курс на ${cbr.date}`);
      if (cbr.fetchedAt !== null && cbr.fetchedAt !== undefined) metaParts.push(`обновлён ${formatClock(cbr.fetchedAt)}`);
      const meta = metaParts.join(" · ");
      const stale = cbr.stale === true;
      return jsxs("div", {
        title: stale && cbr.error !== undefined && cbr.error !== null ? cbr.error : "",
        children: [
          jsx(Row, { label: "$1", value: `${formatRate(rates.USD)} ₽` }),
          jsx(Row, { label: "¥1", value: `${formatRate(rates.CNY)} ₽` }),
          jsx("div", {
            className: stale ? "dpb-caption dpb-warn" : "dpb-caption",
            children: stale ? `${meta} · устарел, курс мог измениться` : meta,
          }),
        ],
      });
    }

    function SpendBlock(props) {
      const spend = props.spend;
      const session = props.session;
      if (spend === undefined || spend === null) return jsx("div", { className: "dpb-muted", children: "Расход: загрузка…" });
      if (spend.error !== undefined && spend.error !== null) {
        return jsx("div", { className: "dpb-error", children: spend.error });
      }
      const day = spend.day ?? {};
      const sessionData = session?.data ?? null;
      const sessionOther = Number(sessionData?.otherCalls) || 0;
      const dayOther = Number(day.otherCalls) || 0;
      const sessionValue =
        sessionData === null
          ? "нет открытой сессии"
          : `≈ ${formatAmount(spend.currency ?? "CNY", sessionData.costCNY)} · ${formatRub(sessionData.rub)}`;
      const sessionTitle =
        sessionData === null
          ? ""
          : `${formatTokens(sessionData.calls)} запросов` +
            (sessionOther > 0 ? ` · ${formatTokens(sessionOther)} не DeepSeek (без стоимости)` : "");
      const dayTitle =
        `${formatTokens(day.calls)} запросов · ${formatTokens(day.tokens)} токенов` +
        (dayOther > 0 ? ` · ${formatTokens(dayOther)} не DeepSeek (без стоимости)` : "");
      return jsxs("div", {
        children: [
          jsx(Row, { label: "Сессия", value: sessionValue, title: sessionTitle }),
          jsx(Row, {
            label: "Сутки",
            value: `≈ ${formatAmount(spend.currency ?? "CNY", day.costCNY)} · ${formatRub(day.rub)}`,
            title: dayTitle,
            strong: true,
          }),
          jsx("div", {
            className: "dpb-caption",
            children: `оценка по официальным ценам DeepSeek · ${formatTokens(day.calls)} запросов за сутки`,
          }),
          dayOther > 0 || sessionOther > 0
            ? jsx("div", {
                className: "dpb-caption",
                children: "запросы других провайдеров не тратят баланс DeepSeek и в оценку не входят",
              })
            : null,
        ],
      });
    }

    function statusOf(snapshot) {
      if (snapshot === null || snapshot === undefined) return "idle";
      if (snapshot.error !== null && snapshot.error !== undefined) return "error";
      if (snapshot.loading === true) return "busy";
      return "ok";
    }

    /**
     * Bottom offset that keeps the floating card above the conversation
     * composer. The composer is a bottom-anchored, centered column; when it
     * reaches the viewport bottom the card lifts clear of the send controls.
     * Home screen (no bottom-anchored composer) keeps the default 16px inset.
     */
    function useComposerClearance() {
      const rootRef = React.useRef(null);
      const [offset, setOffset] = React.useState(16);
      React.useEffect(() => {
        const measure = () => {
          const root = rootRef.current;
          const container = root?.parentElement ?? null;
          const containerRect = container?.getBoundingClientRect() ?? null;
          const viewportBottom = containerRect !== null && containerRect.height > 120 ? containerRect.bottom : window.innerHeight;
          let next = 16;
          let editor = null;
          try {
            editor = document.querySelector('[contenteditable="true"], textarea');
          } catch {
            editor = null;
          }
          let node = editor;
          while (node !== null && node !== document.body) {
            const rect = node.getBoundingClientRect();
            if (rect.height >= 60 && rect.width >= 280 && viewportBottom - rect.bottom <= 40) {
              next = Math.max(16, Math.round(viewportBottom - rect.top + 12));
              break;
            }
            node = node.parentElement;
          }
          if (containerRect !== null && containerRect.height > 120) {
            next = Math.min(next, Math.max(16, Math.round(containerRect.height - 180)));
          }
          setOffset((previous) => (Math.abs(previous - next) > 1 ? next : previous));
        };
        measure();
        window.addEventListener("resize", measure);
        const timer = setInterval(measure, 1000);
        return () => {
          window.removeEventListener("resize", measure);
          clearInterval(timer);
        };
      }, []);
      return [rootRef, offset];
    }

    function Card(props) {
      const [rootRef, bottomOffset] = useComposerClearance();
      const sessionId = props.useSessions(currentSessionIdOf);
      const overview = useOverview(POLL_OVERVIEW_MS);
      const session = useSessionSpend(sessionId, POLL_SESSION_MS);
      const collapsed = useCollapsed();
      const data = overview?.data ?? null;
      const balance = data?.balance ?? null;
      const cbr = data?.cbr ?? null;
      const spend = data?.spend ?? null;
      const status = statusOf(overview);
      const totalRub = balance?.totalRub;
      const refresh = () => {
        void loadOverview(true);
        if (typeof sessionId === "string" && sessionId !== "") void loadSession(sessionId, true);
      };

      if (collapsed) {
        return jsxs("div", {
          className: "dpb-root",
          ref: rootRef,
          style: { bottom: `${bottomOffset}px` },
          children: [
            jsxs("div", {
              className: "dpb-card dpb-collapsed",
              role: "button",
              tabIndex: 0,
              title: "Развернуть баланс DeepSeek",
              onClick: () => setCollapsed(false),
              onKeyDown: (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setCollapsed(false);
                }
              },
              children: [
                jsx("span", { className: `dpb-dot dpb-dot--${status}` }),
                jsx("span", { className: "dpb-strong", children: `≈ ${formatRub(totalRub)}` }),
                jsx("span", {
                  className: "dpb-muted",
                  children: Array.isArray(balance?.wallets)
                    ? balance.wallets.map((wallet) => formatAmount(wallet.currency, wallet.total)).join(" · ")
                    : "",
                }),
                jsx("span", { className: "dpb-collapsed-hint", children: "+" }),
              ],
            }),
          ],
        });
      }

      return jsxs("div", {
        className: "dpb-root",
        ref: rootRef,
        style: { bottom: `${bottomOffset}px` },
        children: [
          jsxs("div", {
            className: "dpb-card",
            children: [
              jsxs("div", {
                className: "dpb-head",
                children: [
                  jsxs("div", {
                    className: "dpb-title",
                    children: [jsx("span", { className: `dpb-dot dpb-dot--${status}` }), jsx("span", { children: "DeepSeek · баланс" })],
                  }),
                  jsxs("div", {
                    className: "dpb-actions",
                    children: [
                      jsx("button", { type: "button", className: "dpb-btn", title: "Обновить", "aria-label": "Обновить", onClick: refresh, children: "⟳" }),
                      jsx("button", {
                        type: "button",
                        className: "dpb-btn",
                        title: "Свернуть",
                        "aria-label": "Свернуть",
                        onClick: () => setCollapsed(true),
                        children: "—",
                      }),
                    ],
                  }),
                ],
              }),
              jsx(BalanceBlock, { balance }),
              jsx("div", { className: "dpb-sep" }),
              jsx(CbrBlock, { cbr }),
              jsx("div", { className: "dpb-sep" }),
              jsx(SpendBlock, { spend, session }),
              overview?.error !== null && overview?.error !== undefined
                ? jsx("div", { className: "dpb-error dpb-caption", children: overview.error })
                : null,
              overview?.at
                ? jsx("div", { className: "dpb-caption dpb-foot", children: `обновлено ${formatClock(overview.at)}` })
                : null,
            ],
          }),
        ],
      });
    }

    function Pill(props) {
      const overview = useOverview(POLL_OVERVIEW_MS);
      const session = useSessionSpend(props.sessionId, POLL_SESSION_MS);
      const collapsed = useCollapsed();
      const data = overview?.data ?? null;
      const balance = data?.balance ?? null;
      const spend = data?.spend ?? null;
      const sessionData = session?.data ?? null;
      const status = statusOf(overview);
      const totalRub = formatRub(balance?.totalRub);
      const dayRub = spend?.day?.rub !== undefined ? formatRub(spend.day.rub) : "— ₽";
      const sessionRub = sessionData !== null ? formatRub(sessionData.rub) : "— ₽";
      const wallets = Array.isArray(balance?.wallets)
        ? balance.wallets.map((wallet) => formatAmount(wallet.currency, wallet.total)).join(" · ")
        : "";
      const tooltip = [
        "Баланс DeepSeek",
        wallets === "" ? "" : wallets,
        balance?.totalRub !== undefined ? `Итого ≈ ${formatRub(balance.totalRub)}` : "",
        data?.cbr?.rates !== undefined
          ? `ЦБ: $1 = ${formatRate(data.cbr.rates.USD)} ₽ · ¥1 = ${formatRate(data.cbr.rates.CNY)} ₽`
          : "",
        `Сессия ≈ ${sessionRub}`,
        (Number(sessionData?.otherCalls) || 0) > 0
          ? `из них ${formatTokens(sessionData.otherCalls)} запросов не DeepSeek — без стоимости`
          : "",
        `Сутки ≈ ${dayRub}`,
        collapsed ? "Нажмите, чтобы развернуть карточку" : "Нажмите, чтобы свернуть карточку",
      ]
        .filter((line) => line !== "")
        .join("\n");
      return jsxs("button", {
        type: "button",
        className: "dpb-pill",
        title: tooltip,
        "aria-label": "Баланс DeepSeek и расход",
        onClick: () => setCollapsed(!collapsedState),
        children: [
          jsx("span", { className: `dpb-dot dpb-dot--${status}` }),
          jsx("span", { className: "dpb-pill-strong", children: `≈ ${totalRub}` }),
          jsx("span", { className: "dpb-pill-sep", children: "·" }),
          jsx("span", { children: `сессия ${sessionRub}` }),
          jsx("span", { className: "dpb-pill-sep", children: "·" }),
          jsx("span", { children: `сутки ${dayRub}` }),
        ],
      });
    }

    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error, info) {
        console.error("[dsh-platform-balance] render failed", error, info?.componentStack);
      }

      render() {
        return this.state.failed ? null : this.props.children;
      }
    }

    function CardSlot(props) {
      return jsx(Boundary, { children: jsx(Card, props) });
    }

    function PillSlot(props) {
      return jsx(Boundary, { children: jsx(Pill, props) });
    }

    // ---------------------------------------------------------------------
    // Styles (host theme tokens with light fallbacks)
    // ---------------------------------------------------------------------
    const CSS = `
.dpb-root{position:absolute;right:16px;bottom:16px;z-index:1;pointer-events:auto;font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif);font-size:12px;line-height:1.45;color:var(--dsw-alias-label-primary,#1f2328);font-variant-numeric:tabular-nums;-webkit-text-size-adjust:100%;text-size-adjust:100%}
.dpb-card{min-width:236px;max-width:300px;padding:10px 12px;border-radius:12px;background:var(--dsw-alias-bg-overlay,#ffffff);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));box-shadow:0 8px 24px rgba(0,0,0,.18);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);box-sizing:border-box}
.dpb-card *{box-sizing:border-box}
.dpb-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.dpb-title{display:flex;align-items:center;gap:6px;font-weight:600;font-size:12.5px;color:var(--dsw-alias-label-primary,#1f2328);min-width:0}
.dpb-actions{display:flex;gap:2px;flex:none}
.dpb-btn{border:none;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary,#59636e);padding:2px 6px;border-radius:6px;font-size:13px;line-height:1.2}
.dpb-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#1f2328)}
.dpb-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#0969da);outline-offset:1px}
.dpb-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:1px 0}
.dpb-row-label{color:var(--dsw-alias-label-secondary,#59636e);white-space:nowrap}
.dpb-row-value{color:var(--dsw-alias-label-primary,#1f2328);white-space:nowrap}
.dpb-strong{font-weight:600}
.dpb-muted{color:var(--dsw-alias-label-secondary,#59636e)}
.dpb-error{color:var(--dsw-alias-state-error-primary,#cf222e)}
.dpb-warn{color:var(--dsw-alias-state-warn-primary,#bf8700)}
.dpb-caption{font-size:11px;color:var(--dsw-alias-label-tertiary,#7a828a);margin-top:2px}
.dpb-foot{margin-top:6px;text-align:right}
.dpb-source{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#7a828a);margin-top:2px}
.dpb-sep{height:1px;margin:7px 0;background:var(--dsw-alias-border-l1,rgba(0,0,0,.10))}
.dpb-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary,#2da44e)}
.dpb-dot--error{background:var(--dsw-alias-state-error-primary,#cf222e)}
.dpb-dot--warn{background:var(--dsw-alias-state-warn-primary,#bf8700)}
.dpb-dot--busy{background:var(--dsw-alias-state-business-primary,#0969da)}
.dpb-dot--idle{background:var(--dsw-alias-label-secondary,#59636e);opacity:.55}
.dpb-collapsed{display:flex;align-items:center;gap:7px;cursor:pointer;padding:7px 10px;min-width:0}
.dpb-collapsed:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dpb-collapsed-hint{margin-left:auto;color:var(--dsw-alias-label-secondary,#59636e);font-weight:600}
.dpb-pill{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04));color:var(--dsw-alias-label-secondary,#59636e);font-family:inherit;font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer;box-sizing:border-box}
.dpb-pill:hover{color:var(--dsw-alias-label-primary,#1f2328);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.07))}
.dpb-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#0969da);outline-offset:1px}
.dpb-pill-strong{font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}
.dpb-pill-sep{opacity:.5}
`;

    function injectStyles() {
      if (typeof document === "undefined") return null;
      if (document.querySelector(`style[${STYLES_MARKER}]`) !== null) return null;
      const style = document.createElement("style");
      style.setAttribute(STYLES_MARKER, "");
      style.textContent = CSS;
      document.head.appendChild(style);
      return style;
    }

    // ---------------------------------------------------------------------
    // Cordis client plugin body
    // ---------------------------------------------------------------------
    const inject = ["slots"];

    function apply(ctx) {
      ctx.effect(
        () => {
          const style = injectStyles();
          return () => {
            style?.remove();
          };
        },
        "dsh-platform-balance: styles",
      );

      ctx.effect(
        () =>
          ctx.slots.inject("shell.overlay", () =>
            ctx.slots.register(
              {
                name: "shell.overlay",
                id: "platform-balance",
                order: 90,
              },
              CardSlot,
            ),
          ),
        "dsh-platform-balance: floating card",
      );

      ctx.effect(
        () =>
          ctx.slots.inject("conversation.session.header.utilities", () =>
            ctx.slots.register(
              {
                name: "conversation.session.header.utilities",
                id: "platform-balance-pill",
                order: 100,
              },
              PillSlot,
            ),
          ),
        "dsh-platform-balance: session header pill",
      );

      // Warm both shared stores before the first slot mounts.
      void loadOverview(false);
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
