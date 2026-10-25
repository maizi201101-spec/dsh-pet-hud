/**
 * 悬浮小宠物 · Client 半边
 *
 * 挂在 shell.overlay 上的固定定位挂件：
 *   - 头顶只有两行数字：绿点 = 余额，黄点 = 自上次重置以来已消耗
 *   - 形象：鲸鱼 / 起司美短 / 机器人，随机眨眼 + 偶尔小动作（纯 SVG + CSS）
 *   - 刷新间隔 30s / 1m / 5m / 1h / 自定义 / 手动；左键 = 立即刷新
 *   - 右键菜单：立即刷新、重置消耗统计、切换形象、设置间隔
 *   - 拖拽移动；拖一张图片到宠物身上可换贴图
 *
 * 数据只来自 ctx.remote.account.getBalance（账号级，多会话/子代理都不串账）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-pet-hud',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState, useRef, useCallback, useMemo } = React;

    /** 账号接口要求的上报版本号；只用于 Platform 侧统计，不参与鉴权。 */
    const APP_VERSION = '0.2.1-rc.2';
    /** 两段透明循环视频（抠像自生成片段）；构建脚本会替换成 data URI。 */
    const VIDEO_IDLE = '__VIDEO_IDLE__';
    const VIDEO_HAPPY = '__VIDEO_HAPPY__';
    const CONFIG_KEY = 'pet-hud.config.v1';
    const BASELINE_KEY = 'pet-hud.baseline.v1';
    const SIZE = 96;
    const MIN_INTERVAL = 15;
    const PRESETS = ['whale', 'cat', 'bot'];
    const PRESET_LABEL = { whale: '鲸鱼', cat: '起司猫', bot: '机器人' };

    const DEFAULT_CONFIG = {
      mode: 'auto',          // 'auto' | 'manual'
      intervalSec: 60,
      preset: 'whale',
      sprite: null,          // data URL，拖图换贴图
      pos: null,             // { x, y }
    };

    // ---------------- 小工具 ----------------

    function readJson(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    }

    function writeJson(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* 隐私模式/配额满：挂件照常工作，只是不记忆 */
      }
    }

    function walletTotals(value) {
      if (!value || value.status !== 'ready') return null;
      const totals = {};
      const all = [...(value.value || []), ...(value.bonusWallets || [])];
      for (const wallet of all) {
        if (!wallet || (wallet.currency !== 'CNY' && wallet.currency !== 'USD')) continue;
        const amount = Number(wallet.balance);
        if (!Number.isFinite(amount)) continue;
        totals[wallet.currency] = (totals[wallet.currency] || 0) + amount;
      }
      return totals;
    }

    function symbol(currency) {
      return currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : currency;
    }

    function money(amount, currency) {
      const sign = amount < 0 ? '-' : '';
      const abs = Math.abs(amount);
      const text = abs.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return sign + symbol(currency) + text;
    }

    function hhmmss(ts) {
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, '0');
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    function hhmm(ts) {
      if (!ts) return '--:--';
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, '0');
      return pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    function currencyList(totals) {
      if (!totals) return [];
      return ['CNY', 'USD'].filter((c) => totals[c] !== undefined);
    }

    /** 没有 ui-session 状态可用时的替身钩子：永远当作没有未读会话。 */
    function useNoUnread() {
      return 0;
    }

    // ---------------- 高峰时段 ----------------

    /**
     * 官方口径：北京时间周一至周五 9:00–12:00、14:00–18:00 为高峰，
     * 其余时段（含周末、法定节假日、调休上班的周末）都按空闲价计费。
     * 节假日按 2026 年国务院安排；没有列到的日期退回“工作日即高峰”。
     */
    const CN_HOLIDAY_RANGES = [
      ['2026-01-01', '2026-01-03'], // 元旦
      ['2026-02-15', '2026-02-23'], // 春节
      ['2026-04-04', '2026-04-06'], // 清明
      ['2026-05-01', '2026-05-05'], // 劳动节
      ['2026-06-19', '2026-06-21'], // 端午
      ['2026-09-25', '2026-09-27'], // 中秋
      ['2026-10-01', '2026-10-07'], // 国庆
    ];

    function isPeakNow(nowMs) {
      const bj = new Date(nowMs + 8 * 3600 * 1000); // 平移到 UTC+8，用 UTC getter 读北京时间
      const day = bj.getUTCDay();
      if (day === 0 || day === 6) return false;
      const pad = (n) => String(n).padStart(2, '0');
      const key = bj.getUTCFullYear() + '-' + pad(bj.getUTCMonth() + 1) + '-' + pad(bj.getUTCDate());
      for (const range of CN_HOLIDAY_RANGES) {
        if (key >= range[0] && key <= range[1]) return false;
      }
      const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes();
      return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
    }

    const PEAK_TIP = '高峰时段：价格为空闲时段的 2 倍（工作日 9:00–12:00、14:00–18:00，北京时间）';

    // ---------------- 形象 ----------------

    function Whale(props) {
      return h('svg', {
        viewBox: '0 0 100 100',
        className: 'pet-hud-svg',
        'data-action': props.action ? '1' : '0',
        'aria-hidden': true,
      },
        h('g', { className: 'pet-hud-body' },
          h('path', {
            className: 'pet-hud-tail',
            d: 'M80 48 q17 -12 14 3 q-2 12 -14 11 z',
            fill: '#6f9bff',
          }),
          h('ellipse', { cx: 46, cy: 60, rx: 34, ry: 26, fill: '#4a7dff' }),
          h('ellipse', { cx: 46, cy: 73, rx: 22, ry: 11, fill: '#dbe6ff' }),
          h('g', { className: 'pet-hud-eyes', 'data-blink': props.blink ? '1' : '0' },
            h('circle', { cx: 34, cy: 57, r: 3.8, fill: '#0f172a' }),
            h('circle', { cx: 53, cy: 57, r: 3.8, fill: '#0f172a' }),
            h('circle', { cx: 35.3, cy: 55.8, r: 1.2, fill: '#fff' }),
            h('circle', { cx: 54.3, cy: 55.8, r: 1.2, fill: '#fff' })),
          h('path', { d: 'M44 34 q1 -12 8 -17', fill: 'none', stroke: '#9fc0ff', strokeWidth: 3, strokeLinecap: 'round' }),
          h('path', { d: 'M30 80 q16 8 34 0', fill: 'none', stroke: '#3a63cc', strokeWidth: 2, strokeLinecap: 'round' })));
    }

    /** 起司猫 · 趴着发呆：头抬起、闭嘴、尾巴卷在身侧。 */
    function CatIdle(props) {
      return h('svg', {
        viewBox: '0 0 100 100',
        className: 'pet-hud-svg',
        'data-action': props.action ? '1' : '0',
        'aria-hidden': true,
      },
        h('g', { className: 'pet-hud-body' },
          h('path', {
            className: 'pet-hud-tail-idle',
            d: 'M75 88 C90 91 93 80 87 75',
            fill: 'none',
            stroke: '#a3abb5',
            strokeWidth: 8,
            strokeLinecap: 'round',
          }),
          h('path', { d: 'M89 85 l5 -2 M91 79 l5 -2', stroke: '#6f7782', strokeWidth: 3, strokeLinecap: 'round' }),
          h('ellipse', { cx: 50, cy: 79, rx: 31, ry: 17, fill: '#a3abb5', stroke: '#b9c2cc', strokeWidth: 1.6 }),
          h('path', {
            d: 'M24 84 C25 74 34 70 50 70 C66 70 75 74 76 84 C70 92 30 92 24 84 Z',
            fill: '#f7f9fb',
            stroke: '#e2e7ed',
            strokeWidth: 1.2,
          }),
          h('ellipse', { cx: 41, cy: 91, rx: 7, ry: 4.2, fill: '#fff', stroke: '#dde3ea', strokeWidth: 1.2 }),
          h('ellipse', { cx: 59, cy: 91, rx: 7, ry: 4.2, fill: '#fff', stroke: '#dde3ea', strokeWidth: 1.2 }),

          h('g', { className: 'pet-hud-ear' },
            h('path', { d: 'M28 23 L20 4 L44 14 Z', fill: '#a3abb5' }),
            h('path', { d: 'M72 23 L80 4 L56 14 Z', fill: '#a3abb5' }),
            h('path', { d: 'M30 20 L26 9 L39 15 Z', fill: '#f2bcc3' }),
            h('path', { d: 'M70 20 L74 9 L61 15 Z', fill: '#f2bcc3' })),

          h('circle', { cx: 50, cy: 44, r: 25, fill: '#fff', stroke: '#c9d1da', strokeWidth: 1.6 }),
          h('path', {
            d: 'M25 42 C27 24 38 16 50 16 C62 16 73 24 75 42 C69 35 64 39 59 35 C54 32 52 36 50 33 C48 36 46 32 41 35 C36 39 31 35 25 42 Z',
            fill: '#a3abb5',
          }),

          h('g', { className: 'pet-hud-eyes', 'data-blink': props.blink ? '1' : '0' },
            h('ellipse', { cx: 39.5, cy: 45, rx: 8.2, ry: 8.8, fill: '#20242b' }),
            h('ellipse', { cx: 60.5, cy: 45, rx: 8.2, ry: 8.8, fill: '#20242b' }),
            h('circle', { cx: 36.6, cy: 41.4, r: 2.8, fill: '#fff' }),
            h('circle', { cx: 57.6, cy: 41.4, r: 2.8, fill: '#fff' })),

          h('path', { d: 'M47 60 L50 62 L53 60 Z', fill: '#ea97a0' }),
          h('path', { d: 'M50 62 q0 3 -3 3.4 M50 62 q0 3 3 3.4', fill: 'none', stroke: '#9aa3ad', strokeWidth: 1.4, strokeLinecap: 'round' }),
          h('path', { d: 'M15 42 l13 2 M15 49 l13 1 M85 42 l-13 2 M85 49 l-13 1', fill: 'none', stroke: '#cbd1d8', strokeWidth: 1.2, strokeLinecap: 'round' })));
    }

    /** 起司猫 · 开心：坐起来、张大嘴、尾巴竖起摇。 */
    function CatHappy(props) {
      return h('svg', {
        viewBox: '0 0 100 100',
        className: 'pet-hud-svg',
        'data-action': props.action ? '1' : '0',
        'aria-hidden': true,
      },
        h('g', { className: 'pet-hud-body' },
          h('path', {
            className: 'pet-hud-tail-happy',
            d: 'M71 90 C91 88 93 62 84 52',
            fill: 'none',
            stroke: '#a3abb5',
            strokeWidth: 9,
            strokeLinecap: 'round',
          }),
          h('path', { d: 'M87 80 l6 -1 M90 68 l5 -3 M85 58 l5 -3', stroke: '#6f7782', strokeWidth: 3.2, strokeLinecap: 'round' }),
          h('ellipse', { cx: 50, cy: 80, rx: 23, ry: 17, fill: '#a3abb5', stroke: '#b9c2cc', strokeWidth: 1.6 }),
          h('path', {
            d: 'M36 89 C36 77 42 71 50 71 C58 71 64 77 64 89 C56 91 44 91 36 89 Z',
            fill: '#f7f9fb',
            stroke: '#e2e7ed',
            strokeWidth: 1.2,
          }),
          h('ellipse', { cx: 39, cy: 93, rx: 8, ry: 4.6, fill: '#fff', stroke: '#dde3ea', strokeWidth: 1.2 }),
          h('ellipse', { cx: 61, cy: 93, rx: 8, ry: 4.6, fill: '#fff', stroke: '#dde3ea', strokeWidth: 1.2 }),

          h('g', { className: 'pet-hud-ear' },
            h('path', { d: 'M27 21 L18 1 L45 12 Z', fill: '#a3abb5' }),
            h('path', { d: 'M73 21 L82 1 L55 12 Z', fill: '#a3abb5' }),
            h('path', { d: 'M29 18 L24 5 L39 12 Z', fill: '#f2bcc3' }),
            h('path', { d: 'M71 18 L76 5 L61 12 Z', fill: '#f2bcc3' })),

          h('circle', { cx: 50, cy: 42, r: 27, fill: '#fff', stroke: '#c9d1da', strokeWidth: 1.6 }),
          h('path', {
            d: 'M23 40 C25 21 37 13 50 13 C63 13 75 21 77 40 C71 33 65 37 60 33 C55 30 52 34 50 31 C48 34 45 30 40 33 C35 37 29 33 23 40 Z',
            fill: '#a3abb5',
          }),

          h('g', { className: 'pet-hud-eyes', 'data-blink': props.blink ? '1' : '0' },
            h('ellipse', { cx: 39.5, cy: 43, rx: 8.6, ry: 9.2, fill: '#20242b' }),
            h('ellipse', { cx: 60.5, cy: 43, rx: 8.6, ry: 9.2, fill: '#20242b' }),
            h('circle', { cx: 36.6, cy: 39.4, r: 3, fill: '#fff' }),
            h('circle', { cx: 57.6, cy: 39.4, r: 3, fill: '#fff' })),

          h('path', {
            d: 'M50 54 Q39 55 41 63 Q50 76 59 63 Q61 55 50 54 Z',
            fill: '#f4a7ab',
            stroke: '#c88086',
            strokeWidth: 1.3,
            strokeLinejoin: 'round',
          }),
          h('path', { d: 'M50 61 Q45 62 45 66 Q50 72 55 66 Q55 62 50 61 Z', fill: '#e2797f' }),
          h('path', { d: 'M14 39 l14 2 M14 46 l14 1 M86 39 l-14 2 M86 46 l-14 1', fill: 'none', stroke: '#cbd1d8', strokeWidth: 1.2, strokeLinecap: 'round' })));
    }

    function Bot(props) {
      return h('svg', {
        viewBox: '0 0 100 100',
        className: 'pet-hud-svg',
        'data-action': props.action ? '1' : '0',
        'aria-hidden': true,
      },
        h('g', { className: 'pet-hud-body' },
          h('g', { className: 'pet-hud-antenna' },
            h('path', { d: 'M50 27 L50 16', stroke: '#7f8ea8', strokeWidth: 4, strokeLinecap: 'round' }),
            h('circle', { cx: 50, cy: 13, r: 5, fill: '#ffd166' })),
          h('rect', { x: 22, y: 28, width: 56, height: 46, rx: 14, fill: '#8fa4c8' }),
          h('rect', { x: 30, y: 38, width: 40, height: 22, rx: 8, fill: '#16233a' }),
          h('g', { className: 'pet-hud-eyes', 'data-blink': props.blink ? '1' : '0' },
            h('circle', { cx: 42, cy: 49, r: 3.8, fill: '#7fe3ff' }),
            h('circle', { cx: 58, cy: 49, r: 3.8, fill: '#7fe3ff' })),
          h('rect', { x: 20, y: 46, width: 5, height: 12, rx: 2.5, fill: '#6c82a8' }),
          h('rect', { x: 75, y: 46, width: 5, height: 12, rx: 2.5, fill: '#6c82a8' }),
          h('path', { d: 'M40 72 q10 6 20 0', fill: 'none', stroke: '#44557a', strokeWidth: 3, strokeLinecap: 'round' })));
    }

    /** 起司猫：两段透明循环视频，发呆 / 开心叠层交叉淡入。 */
    function CatVideo(props) {
      return h('div', { className: 'pet-hud-videos' },
        h('video', {
          ref: props.idleRef,
          className: 'pet-hud-video',
          'data-active': props.mood === 'idle' ? '1' : '0',
          src: VIDEO_IDLE,
          autoPlay: true,
          muted: true,
          loop: true,
          playsInline: true,
          preload: 'auto',
          disablePictureInPicture: true,
          'aria-hidden': true,
        }),
        h('video', {
          ref: props.happyRef,
          className: 'pet-hud-video',
          'data-active': props.mood === 'happy' ? '1' : '0',
          src: VIDEO_HAPPY,
          autoPlay: true,
          muted: true,
          loop: true,
          playsInline: true,
          preload: 'auto',
          disablePictureInPicture: true,
          'aria-hidden': true,
        }));
    }

    function PetShape(props) {
      if (props.sprite) return h('img', { src: props.sprite, alt: '宠物贴图', draggable: false });
      if (props.preset === 'cat') return h(CatVideo, props);
      if (props.preset === 'bot') return h(Bot, props);
      return h(Whale, props);
    }

    // ---------------- 样式 ----------------

    const CSS = `
.pet-hud-root{position:fixed;z-index:30;display:flex;flex-direction:column;align-items:center;width:100px;
  user-select:none;-webkit-user-select:none;
  font:12px/1.55 var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif)}
.pet-hud-pet{position:relative;width:${SIZE}px;height:${SIZE}px;display:flex;align-items:flex-end;justify-content:center;
  cursor:pointer;touch-action:none;filter:drop-shadow(0 8px 16px rgba(0,0,0,.18))}
.pet-hud-pet:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4a7dff);outline-offset:4px;border-radius:16px}
.pet-hud-svg{width:92px;height:92px;overflow:visible;transform-origin:50% 100%}
.pet-hud-pet img{width:88px;height:88px;object-fit:contain;animation:pet-hud-breathe 3.6s ease-in-out infinite;transform-origin:50% 100%}
.pet-hud-body{animation:pet-hud-breathe 3.6s ease-in-out infinite;transform-box:fill-box;transform-origin:50% 100%}
.pet-hud-eyes{transform-box:fill-box;transform-origin:center;transition:transform .1s ease}
.pet-hud-eyes[data-blink="1"]{transform:scaleY(.08)}
.pet-hud-tail{transform-box:fill-box;transform-origin:0% 50%}
.pet-hud-ear{transform-box:fill-box;transform-origin:50% 100%}
.pet-hud-antenna{transform-box:fill-box;transform-origin:50% 100%}
.pet-hud-poses{position:relative;width:92px;height:92px}
.pet-hud-pose{position:absolute;inset:0;transition:opacity .3s ease,transform .3s ease;transform-origin:50% 100%}
.pet-hud-pose[data-active="0"]{opacity:0;transform:scale(.94) translateY(3px);pointer-events:none}
.pet-hud-videos{position:relative;width:96px;height:98px}
.pet-hud-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;
  opacity:0;transition:opacity .35s ease;pointer-events:none}
.pet-hud-video[data-active="1"]{opacity:1}
.pet-hud-root[data-wander="1"]{transition:transform 2.6s cubic-bezier(.45,0,.55,1)}
.pet-hud-root[data-wander="1"] .pet-hud-pet{animation:pet-hud-bob .62s ease-in-out infinite}
.pet-hud-pet[data-face="left"] video,.pet-hud-pet[data-face="left"] img,.pet-hud-pet[data-face="left"] svg{transform:scaleX(-1)}
@keyframes pet-hud-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
.pet-hud-tail-happy{transform-box:fill-box;transform-origin:0% 92%;animation:pet-hud-wag 2.6s ease-in-out infinite}
.pet-hud-tail-idle{transform-box:fill-box;transform-origin:100% 92%}
.pet-hud-svg[data-action="1"] .pet-hud-tail-idle{animation:pet-hud-wag .8s ease-in-out}
.pet-hud-svg[data-action="1"]{animation:pet-hud-hop .9s ease-in-out}
.pet-hud-svg[data-action="1"] .pet-hud-tail{animation:pet-hud-wag .85s ease-in-out}
.pet-hud-svg[data-action="1"] .pet-hud-ear{animation:pet-hud-twitch .85s ease-in-out}
.pet-hud-svg[data-action="1"] .pet-hud-antenna{animation:pet-hud-twitch .85s ease-in-out}
@keyframes pet-hud-breathe{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-3px) scale(1.025)}}
@keyframes pet-hud-hop{0%,100%{transform:translateY(0)}40%{transform:translateY(-5px)}70%{transform:translateY(0)}}
@keyframes pet-hud-wag{0%,100%{transform:rotate(0)}25%{transform:rotate(-10deg)}55%{transform:rotate(7deg)}80%{transform:rotate(-4deg)}}
@keyframes pet-hud-twitch{0%,100%{transform:rotate(0)}30%{transform:rotate(-8deg)}60%{transform:rotate(5deg)}}
@media (prefers-reduced-motion:reduce){
  .pet-hud-body,.pet-hud-pet img{animation:none}
  .pet-hud-svg[data-action="1"],.pet-hud-svg[data-action="1"] .pet-hud-tail,
  .pet-hud-svg[data-action="1"] .pet-hud-ear,.pet-hud-svg[data-action="1"] .pet-hud-antenna{animation:none}
  .pet-hud-eyes{transition:none}
  .pet-hud-pose{transition:none}
  .pet-hud-tail-happy{animation:none}
  .pet-hud-root[data-wander="1"]{transition:none}
  .pet-hud-root[data-wander="1"] .pet-hud-pet{animation:none}
}
.pet-hud-readout{display:flex;justify-content:space-between;align-items:center;width:100%;margin-top:1px;
  pointer-events:none;font-variant-numeric:tabular-nums;font-size:11px;font-weight:600;line-height:1.2;
  color:var(--dsw-alias-label-primary,#111);text-shadow:0 0 4px var(--dsw-alias-bg-base,#fff),0 1px 2px rgba(0,0,0,.18)}
.pet-hud-readout[data-busy="1"]{opacity:.6}
.pet-hud-readout[data-dim="1"]{opacity:.55}
.pet-hud-num{display:flex;align-items:center;gap:5px;white-space:nowrap}
.pet-hud-dot{width:7px;height:7px;border-radius:50%;flex:none;box-shadow:0 0 0 1px rgba(0,0,0,.10)}
.pet-hud-dot[data-kind="balance"]{background:#2fbf71}
.pet-hud-dot[data-kind="spent"]{background:#e6a52b}
.pet-hud-dot[data-kind="balance"][data-peak="1"]{background:#e05a5a}
.pet-hud-menu{position:fixed;z-index:31;min-width:190px;padding:6px;border-radius:10px;
  border:.5px solid var(--dsw-alias-border-l3,rgba(120,120,120,.35));background:var(--dsw-alias-bg-base,#fff);
  color:var(--dsw-alias-label-primary,#111);box-shadow:0 14px 36px rgba(0,0,0,.2);font-size:12px}
.pet-hud-item{display:flex;justify-content:space-between;align-items:center;gap:12px;width:100%;
  padding:6px 8px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.pet-hud-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,120,.14))}
.pet-hud-item[data-active="1"]{color:var(--dsw-alias-state-business-primary,#4a7dff);font-weight:600}
.pet-hud-sep{height:.5px;margin:5px 6px;background:var(--dsw-alias-border-l3,rgba(120,120,120,.35))}
.pet-hud-cap{padding:4px 8px 2px;color:var(--dsw-alias-label-tertiary,#888);font-size:10.5px}
.pet-hud-k{color:var(--dsw-alias-label-tertiary,#888);font-size:11px}
.pet-hud-custom{display:flex;gap:6px;padding:4px 8px 6px}
.pet-hud-custom input{flex:1;min-width:0;padding:4px 6px;border-radius:6px;font:inherit;
  border:.5px solid var(--dsw-alias-border-l3,rgba(120,120,120,.45));background:transparent;color:inherit}
.pet-hud-custom button{padding:4px 8px;border-radius:6px;font:inherit;cursor:pointer;
  border:.5px solid var(--dsw-alias-border-l3,rgba(120,120,120,.45));background:transparent;color:inherit}
`;

    function ensureCss() {
      if (typeof document === 'undefined') return;
      if (document.querySelector('style[data-plugin-css="dsh-pet-hud"]') !== null) return;
      const tag = document.createElement('style');
      tag.setAttribute('data-plugin-css', 'dsh-pet-hud');
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ---------------- 挂件 ----------------

    function createPetHud(ctx) {
      return function PetHud(props) {
        ensureCss();

        // 原生 ui-session 的 completionUnread：会话跑完、但你还没点进去看时为真。
        // 根作用域的 slot 会拿到 useSessionStatus；拿不到就当作没有未读。
        const useStatus = typeof props.useSessionStatus === 'function' ? props.useSessionStatus : useNoUnread;
        const unreadCount = useStatus((status) => {
          if (!status || typeof status.values !== 'function') return 0;
          let count = 0;
          for (const entry of status.values()) if (entry && entry.completionUnread === true) count += 1;
          return count;
        });
        // 自己记一份“跑完还没看”的集合：原生只标非主视图，主视图的完成得自己补。
        const runningIds = useStatus((status) => {
          if (!status || typeof status.values !== 'function') return '';
          const ids = [];
          for (const [id, entry] of status) if (entry && entry.running === true) ids.push(id);
          return ids.sort().join(',');
        });
        const useSessions = typeof props.useSessions === 'function' ? props.useSessions : null;
        const mainIds = useSessions ? useSessions((list) => {
          if (!list || !list.byId) return '';
          const ids = [];
          for (const id of Object.keys(list.byId)) {
            const row = list.byId[id];
            if (row && row.retainedBy && row.retainedBy.mainView > 0) ids.push(id);
          }
          return ids.sort().join(',');
        }) : '';

        const [cfg, setCfg] = useState(() => ({ ...DEFAULT_CONFIG, ...readJson(CONFIG_KEY, {}) }));
        const [baseline, setBaseline] = useState(() => readJson(BASELINE_KEY, null));
        const [balance, setBalance] = useState({ status: 'idle', totals: null, at: 0, error: null });
        const [busy, setBusy] = useState(false);
        const [pos, setPos] = useState(() => cfg.pos || null);
        const [menu, setMenu] = useState(null);   // { x, y }
        const [customOpen, setCustomOpen] = useState(false);
        const [customValue, setCustomValue] = useState('');
        const [now, setNow] = useState(() => Date.now());
        const [blink, setBlink] = useState(false);
        const [action, setAction] = useState(false);
        const [finished, setFinished] = useState('');
        const [petted, setPetted] = useState(false);
        const [wander, setWander] = useState(null); // { x, y } 或 null
        const pettedTimerRef = useRef(0);
        const mood = unreadCount > 0 || finished !== '' || petted ? 'happy' : 'idle';

        const idleVideoRef = useRef(null);
        const happyVideoRef = useRef(null);
        const seqRef = useRef(0);
        const dragRef = useRef(null);
        const posRef = useRef(pos);
        const rootRef = useRef(null);
        const cfgRef = useRef(cfg);
        cfgRef.current = cfg;
        posRef.current = pos;

        // 每秒刷新「多久之前」，不触发网络。
        useEffect(() => {
          // 读数只需要“多久没刷新”，5 秒精度足够，没必要每秒重渲染。
          const id = setInterval(() => setNow(Date.now()), 5000);
          return () => clearInterval(id);
        }, []);

        // 眨眼与小动作：间隔随机，看起来不像机械循环。
        useEffect(() => {
          let cancelled = false;
          let blinkTimer = 0;
          let blinkReset = 0;
          let actionTimer = 0;
          let actionReset = 0;

          const scheduleBlink = () => {
            blinkTimer = setTimeout(() => {
              if (cancelled) return;
              setBlink(true);
              blinkReset = setTimeout(() => {
                if (cancelled) return;
                setBlink(false);
                scheduleBlink();
              }, 150);
            }, 2200 + Math.random() * 4200);
          };

          const scheduleAction = () => {
            actionTimer = setTimeout(() => {
              if (cancelled) return;
              setAction(true);
              actionReset = setTimeout(() => {
                if (cancelled) return;
                setAction(false);
                scheduleAction();
              }, 900);
            }, 6000 + Math.random() * 9000);
          };

          scheduleBlink();
          scheduleAction();
          return () => {
            cancelled = true;
            clearTimeout(blinkTimer);
            clearTimeout(blinkReset);
            clearTimeout(actionTimer);
            clearTimeout(actionReset);
          };
        }, []);

        // 只解码当前姿态那一段；窗口不可见时两段都停。
        useEffect(() => {
          const active = mood === 'happy' ? happyVideoRef.current : idleVideoRef.current;
          const inactive = mood === 'happy' ? idleVideoRef.current : happyVideoRef.current;
          const sync = () => {
            const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
            if (inactive && !inactive.paused) inactive.pause();
            if (!visible) {
              if (active && !active.paused) active.pause();
              return;
            }
            if (active && active.paused) active.play().catch(() => {});
          };
          sync();
          if (typeof document !== 'undefined') document.addEventListener('visibilitychange', sync);
          return () => {
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', sync);
          };
        }, [mood]);

        // 随机溜达：每隔 6–15 分钟沿着一个随机方向平移出去，再走回来。
        useEffect(() => {
          if (typeof window === 'undefined') return undefined;
          if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
          let cancelled = false;
          const timers = [];
          const schedule = () => {
            if (cancelled) return;
            timers.push(setTimeout(walk, (6 + Math.random() * 9) * 60 * 1000));
          };
          const walk = () => {
            if (cancelled) return;
            if (document.visibilityState !== 'visible' || dragRef.current) { schedule(); return; }
            const dx = (Math.random() < 0.5 ? -1 : 1) * (50 + Math.random() * 80);
            const dy = (Math.random() - 0.5) * 36;
            setWander({ x: dx, y: dy });
            timers.push(setTimeout(() => {
              if (cancelled) return;
              setWander({ x: 0, y: 0 });
              timers.push(setTimeout(() => {
                if (cancelled) return;
                setWander(null);
                schedule();
              }, 2700));
            }, 2700));
          };
          schedule();
          return () => {
            cancelled = true;
            for (const id of timers) clearTimeout(id);
          };
        }, []);

        // 左键摸一下：开心 4 秒（约一个完整开心循环）再回到应有状态。
        const petOnce = useCallback(() => {
          setPetted(true);
          clearTimeout(pettedTimerRef.current);
          pettedTimerRef.current = setTimeout(() => setPetted(false), 4000);
        }, []);

        useEffect(() => () => clearTimeout(pettedTimerRef.current), []);

        // 会话跑完（running 从有到无）→ 记进 finished；重新跑起来就撤销。
        const prevRunningRef = useRef('');
        useEffect(() => {
          const prev = prevRunningRef.current.split(',').filter(Boolean);
          const now = runningIds.split(',').filter(Boolean);
          prevRunningRef.current = runningIds;
          const ended = prev.filter((id) => !now.includes(id));
          const restarted = now.filter((id) => !prev.includes(id));
          if (ended.length === 0 && restarted.length === 0) return;
          setFinished((current) => {
            const set = new Set(current.split(',').filter(Boolean));
            for (const id of ended) set.add(id);
            for (const id of restarted) set.delete(id);
            return [...set].sort().join(',');
          });
        }, [runningIds]);

        // 会话进入主视图 = 你已经看到了，从 finished 里移除。
        useEffect(() => {
          if (!mainIds) return;
          const mains = mainIds.split(',').filter(Boolean);
          setFinished((current) => {
            const set = new Set(current.split(',').filter(Boolean));
            let changed = false;
            for (const id of mains) if (set.delete(id)) changed = true;
            return changed ? [...set].sort().join(',') : current;
          });
        }, [mainIds]);

        // 只有“在主视图里开始输入”才算下一步动作：焦点进入可编辑区，或在可编辑区敲键。
        // 只收掉当前主视图的完成状态，别的会话的未读不受影响。
        useEffect(() => {
          if (!finished) return undefined;
          const editable = (el) => {
            if (!el || el.nodeType !== 1) return false;
            const tag = el.tagName;
            return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
          };
          const stop = (event) => {
            const target = event.target;
            if (rootRef.current && target && rootRef.current.contains(target)) return;
            if (!editable(target)) return;
            // 拿不到主视图信息时退化为“清掉全部”，避免挂件卡在开心；
            // 拿得到时只清当前主视图，别的会话的完成状态保留。
            const mains = mainIds ? new Set(mainIds.split(',').filter(Boolean)) : null;
            setFinished((current) => {
              if (mains === null) return '';
              const set = new Set(current.split(',').filter(Boolean));
              let changed = false;
              for (const id of mains) if (set.delete(id)) changed = true;
              return changed ? [...set].sort().join(',') : current;
            });
          };
          document.addEventListener('keydown', stop, true);
          document.addEventListener('focusin', stop, true);
          return () => {
            document.removeEventListener('keydown', stop, true);
            document.removeEventListener('focusin', stop, true);
          };
        }, [finished, mainIds]);

        // 默认位置：右下角。
        useEffect(() => {
          if (pos) return;
          const x = Math.max(8, window.innerWidth - SIZE - 28);
          const y = Math.max(8, window.innerHeight - 112 - 120);
          setPos({ x, y });
        }, [pos]);

        const persist = useCallback((next) => {
          setCfg(next);
          writeJson(CONFIG_KEY, next);
        }, []);

        /** 拉一次余额；成功时返回各币种总额，失败/未登录返回 null。 */
        const fetchBalance = useCallback(async () => {
          const seq = ++seqRef.current;
          setBusy(true);
          try {
            const active = (() => {
              try { return ctx.locale.getSnapshot().active; } catch { return 'zh-CN'; }
            })();
            const result = await ctx.remote.account.getBalance({
              version: APP_VERSION,
              locale: active || 'zh-CN',
              timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
            });
            if (seq !== seqRef.current) return null;
            if (!result.ok) throw result.error ?? new Error('余额请求失败');
            const value = result.value;
            if (value === null) {
              setBalance({ status: 'signed-out', totals: null, at: Date.now(), error: null });
              return null;
            }
            if (value.status === 'failed') {
              setBalance({ status: 'error', totals: null, at: Date.now(), error: '账号查询失败' });
              return null;
            }
            const totals = walletTotals(value);
            setBalance({ status: 'ok', totals, at: Date.now(), error: null });
            return totals;
          } catch (error) {
            if (seq !== seqRef.current) return null;
            setBalance({ status: 'error', totals: null, at: Date.now(), error: String((error && error.message) || error) });
            return null;
          } finally {
            if (seq === seqRef.current) setBusy(false);
          }
        }, [ctx]);

        // 挂载即拉一次。
        useEffect(() => {
          fetchBalance();
        }, [fetchBalance]);

        // 定时刷新：只在页面可见时真的发请求。
        useEffect(() => {
          if (cfg.mode !== 'auto') return undefined;
          const every = Math.max(MIN_INTERVAL, Number(cfg.intervalSec) || 60) * 1000;
          const id = setInterval(() => {
            if (document.visibilityState === 'visible') fetchBalance();
          }, every);
          return () => clearInterval(id);
        }, [cfg.mode, cfg.intervalSec, fetchBalance]);

        // 回到前台时补一次：切换窗口/标签回来，数字不该是旧的。
        useEffect(() => {
          const onVisible = () => {
            if (document.visibilityState !== 'visible') return;
            if (cfgRef.current.mode !== 'auto') return;
            const age = Date.now() - (balance.at || 0);
            if (age > Math.max(MIN_INTERVAL, Number(cfgRef.current.intervalSec) || 60) * 1000) fetchBalance();
          };
          document.addEventListener('visibilitychange', onVisible);
          window.addEventListener('focus', onVisible);
          return () => {
            document.removeEventListener('visibilitychange', onVisible);
            window.removeEventListener('focus', onVisible);
          };
        }, [balance.at, fetchBalance]);

        // 点空白处关菜单。
        useEffect(() => {
          if (!menu) return undefined;
          const close = (event) => {
            if (rootRef.current && rootRef.current.contains(event.target)) return;
            setMenu(null);
            setCustomOpen(false);
          };
          const onKey = (event) => {
            if (event.key === 'Escape') {
              setMenu(null);
              setCustomOpen(false);
            }
          };
          window.addEventListener('pointerdown', close, true);
          window.addEventListener('keydown', onKey);
          return () => {
            window.removeEventListener('pointerdown', close, true);
            window.removeEventListener('keydown', onKey);
          };
        }, [menu]);

        const consumed = useMemo(() => {
          if (!baseline || !baseline.totals || balance.status !== 'ok' || !balance.totals) return null;
          const amounts = {};
          let toppedUp = false;
          for (const currency of currencyList(baseline.totals)) {
            if (balance.totals[currency] === undefined) continue;
            const delta = baseline.totals[currency] - balance.totals[currency];
            if (delta < 0) toppedUp = true;
            amounts[currency] = Math.max(0, delta);
          }
          return { amounts, toppedUp };
        }, [baseline, balance]);

        const resetBaseline = useCallback(async () => {
          setMenu(null);
          // 用「刚刚」的余额当基线，而不是屏幕上可能已经旧了的数字。
          const totals = await fetchBalance();
          if (!totals) return;
          const next = { at: Date.now(), totals: { ...totals } };
          setBaseline(next);
          writeJson(BASELINE_KEY, next);
        }, [fetchBalance]);

        const applyInterval = useCallback((seconds) => {
          const value = Math.max(MIN_INTERVAL, Math.round(Number(seconds) || 60));
          persist({ ...cfgRef.current, mode: 'auto', intervalSec: value });
          setMenu(null);
          setCustomOpen(false);
          fetchBalance();
        }, [persist, fetchBalance]);

        const setManual = useCallback(() => {
          persist({ ...cfgRef.current, mode: 'manual' });
          setMenu(null);
          setCustomOpen(false);
        }, [persist]);

        const setPreset = useCallback((next) => {
          persist({ ...cfgRef.current, preset: next, sprite: null });
          setMenu(null);
        }, [persist]);

        // 拖拽 + 点击。
        const onPointerDown = useCallback((event) => {
          if (event.button !== 0) return;
          setWander(null);
          dragRef.current = {
            startX: event.clientX,
            startY: event.clientY,
            origin: posRef.current || { x: 0, y: 0 },
            moved: false,
            id: event.pointerId,
          };
          try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 忽略 */ }
        }, []);

        const onPointerMove = useCallback((event) => {
          const drag = dragRef.current;
          if (!drag || drag.id !== event.pointerId) return;
          const dx = event.clientX - drag.startX;
          const dy = event.clientY - drag.startY;
          if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
          drag.moved = true;
          const maxX = Math.max(8, window.innerWidth - 104 - 8);
          const maxY = Math.max(8, window.innerHeight - 112 - 8);
          setPos({
            x: Math.min(maxX, Math.max(8, drag.origin.x + dx)),
            y: Math.min(maxY, Math.max(8, drag.origin.y + dy)),
          });
        }, []);

        const onPointerUp = useCallback((event) => {
          const drag = dragRef.current;
          if (!drag || drag.id !== event.pointerId) return;
          dragRef.current = null;
          try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* 忽略 */ }
          if (drag.moved) {
            // 位置在 pointermove 里已经落到 posRef，这里只负责记住。
            if (posRef.current) persist({ ...cfgRef.current, pos: posRef.current });
          } else if (event.button === 0) {
            petOnce();
            fetchBalance();
          }
        }, [fetchBalance, persist, petOnce]);

        const onContextMenu = useCallback((event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }, []);

        const onDrop = useCallback((event) => {
          event.preventDefault();
          const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
          if (!file || !/^image\//.test(file.type)) return;
          if (file.size > 800 * 1024) {
            window.alert('贴图太大了，控制在 800KB 以内（gif/png/webp）。');
            return;
          }
          const reader = new FileReader();
          reader.onload = () => {
            persist({ ...cfgRef.current, sprite: String(reader.result) });
          };
          reader.readAsDataURL(file);
        }, [persist]);

        const walletLines = currencyList(balance.totals);
        const consumedLines = consumed ? currencyList(consumed.amounts) : [];

        const intervalMs = Math.max(MIN_INTERVAL * 1000, (Number(cfg.intervalSec) || 60) * 1000);
        const stale = Boolean(balance.at) && now - balance.at > Math.max(intervalMs, intervalMs * 2);

        const peak = isPeakNow(now);

        const intervalLabel = cfg.mode === 'manual'
          ? '手动刷新'
          : cfg.intervalSec % 3600 === 0 ? (cfg.intervalSec / 3600) + ' 小时'
            : cfg.intervalSec % 60 === 0 ? (cfg.intervalSec / 60) + ' 分钟'
              : cfg.intervalSec + ' 秒';

        const balanceText = balance.status === 'ok' && walletLines.length > 0
          ? walletLines.map((c) => money(balance.totals[c], c)).join(' ')
          : balance.status === 'ok' ? '—'
            : balance.status === 'idle' ? '…' : '—';

        const spentText = consumed && consumedLines.length > 0
          ? consumedLines.map((c) => money(consumed.amounts[c], c)).join(' ')
          : '—';

        // 悬停提示承担所有文字说明，头顶只留两个数字。
        const tipLines = [];
        if (balance.status === 'ok') {
          for (const c of walletLines) tipLines.push('余额 ' + money(balance.totals[c], c));
          for (const c of consumedLines) tipLines.push('已消耗 ' + money(consumed.amounts[c], c) + (baseline ? '（自 ' + hhmm(baseline.at) + ' 起）' : ''));
          if (consumed && consumed.toppedUp) tipLines.push('期间有充值，差额含充值额');
          tipLines.push('更新于 ' + hhmmss(balance.at) + ' · ' + intervalLabel);
        } else if (balance.status === 'signed-out') {
          tipLines.push('未登录 Platform 账号，读不到余额');
        } else if (balance.status === 'error') {
          tipLines.push('余额查询失败：' + (balance.error || '未知原因'));
        } else {
          tipLines.push('正在查询余额…');
        }
        if (unreadCount > 0) tipLines.push('有 ' + unreadCount + ' 个跑完还没查看的会话（绿点旁的侧栏标记同源）');
        if (peak) tipLines.push(PEAK_TIP);
        else if (finished) tipLines.push('有会话刚跑完，等你下一步操作');
        tipLines.push('左键：开心一下并刷新 · 右键菜单 · 拖动移动 · 拖图片换贴图');
        const tip = tipLines.join('\n');

        const readout = h('div', {
          className: 'pet-hud-readout',
          'data-busy': busy ? '1' : '0',
          'data-dim': stale ? '1' : '0',
        },
          h('div', { className: 'pet-hud-num' },
            h('span', { className: 'pet-hud-dot', 'data-kind': 'balance', 'data-peak': peak ? '1' : '0' }),
            h('span', {}, balanceText)),
          h('div', { className: 'pet-hud-num' },
            h('span', { className: 'pet-hud-dot', 'data-kind': 'spent' }),
            h('span', {}, spentText)));

        const pet = h('div', {
          className: 'pet-hud-pet',
          'data-face': wander && wander.x < 0 ? 'left' : 'right',
          role: 'button',
          tabIndex: 0,
          'aria-label': '余额小宠物：左键刷新，右键菜单，拖动可移动',
          title: tip,
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerUp,
          onContextMenu,
          onDragOver: (event) => event.preventDefault(),
          onDrop,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              fetchBalance();
            }
          },
        },
          h(PetShape, { preset: cfg.preset, sprite: cfg.sprite, blink, action, mood, idleRef: idleVideoRef, happyRef: happyVideoRef }));

        const menuItems = [];

        menuItems.push(h('button', {
          key: 'refresh',
          className: 'pet-hud-item',
          role: 'menuitem',
          onClick: () => { setMenu(null); fetchBalance(); },
        }, h('span', {}, '立即刷新'), h('span', { className: 'pet-hud-k' }, busy ? '…' : '')));

        menuItems.push(h('button', {
          key: 'reset',
          className: 'pet-hud-item',
          role: 'menuitem',
          onClick: resetBaseline,
        }, h('span', {}, '重置消耗统计'), h('span', { className: 'pet-hud-k' }, '以当前余额为基线')));

        menuItems.push(h('div', { key: 'sep1', className: 'pet-hud-sep' }));
        menuItems.push(h('div', { key: 'cap1', className: 'pet-hud-cap' }, '刷新间隔'));

        for (const seconds of [30, 60, 300, 3600]) {
          const active = cfg.mode === 'auto' && Number(cfg.intervalSec) === seconds;
          const label = seconds === 30 ? '30 秒' : seconds === 60 ? '1 分钟' : seconds === 300 ? '5 分钟' : '1 小时';
          menuItems.push(h('button', {
            key: 'i' + seconds,
            className: 'pet-hud-item',
            role: 'menuitemradio',
            'data-active': active ? '1' : '0',
            onClick: () => applyInterval(seconds),
          }, h('span', {}, label), h('span', { className: 'pet-hud-k' }, active ? '✓' : '')));
        }

        menuItems.push(h('button', {
          key: 'manual',
          className: 'pet-hud-item',
          role: 'menuitemradio',
          'data-active': cfg.mode === 'manual' ? '1' : '0',
          onClick: setManual,
        }, h('span', {}, '手动'), h('span', { className: 'pet-hud-k' }, cfg.mode === 'manual' ? '✓' : '')));

        const customActive = cfg.mode === 'auto' && ![30, 60, 300, 3600].includes(Number(cfg.intervalSec));

        menuItems.push(h('button', {
          key: 'custom',
          className: 'pet-hud-item',
          role: 'menuitemradio',
          'data-active': customActive || customOpen ? '1' : '0',
          onClick: () => {
            setCustomOpen((open) => !open);
            setCustomValue(String(cfg.intervalSec));
          },
        }, h('span', {}, '自定义…'), h('span', { className: 'pet-hud-k' }, customActive ? String(cfg.intervalSec) + 's' : '')));

        if (customOpen) {
          menuItems.push(h('div', { key: 'customRow', className: 'pet-hud-custom' },
            h('input', {
              type: 'number',
              min: String(MIN_INTERVAL),
              step: '5',
              value: customValue,
              autoFocus: true,
              onChange: (event) => setCustomValue(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') applyInterval(customValue);
              },
            }),
            h('span', { className: 'pet-hud-k', style: { alignSelf: 'center' } }, '秒'),
            h('button', { onClick: () => applyInterval(customValue) }, '确定')));
        }

        menuItems.push(h('div', { key: 'sep2', className: 'pet-hud-sep' }));
        menuItems.push(h('div', { key: 'cap2', className: 'pet-hud-cap' }, '形象'));

        for (const name of PRESETS) {
          const active = !cfg.sprite && cfg.preset === name;
          menuItems.push(h('button', {
            key: 'p' + name,
            className: 'pet-hud-item',
            role: 'menuitemradio',
            'data-active': active ? '1' : '0',
            onClick: () => setPreset(name),
          }, h('span', {}, PRESET_LABEL[name]), h('span', { className: 'pet-hud-k' }, active ? '✓' : '')));
        }

        if (cfg.sprite) {
          menuItems.push(h('button', {
            key: 'clearSprite',
            className: 'pet-hud-item',
            role: 'menuitem',
            onClick: () => { setMenu(null); persist({ ...cfgRef.current, sprite: null }); },
          }, h('span', {}, '清除自定义贴图')));
        }

        menuItems.push(h('div', { key: 'sep3', className: 'pet-hud-sep' }));
        menuItems.push(h('div', { key: 'hint', className: 'pet-hud-cap', style: { lineHeight: '1.6' } },
          '拖图片到宠物身上可换贴图（≤800KB）'));

        const menuEl = menu ? h('div', {
          className: 'pet-hud-menu',
          style: {
            left: Math.min(menu.x, Math.max(8, window.innerWidth - 214)),
            top: Math.min(menu.y, Math.max(8, window.innerHeight - 340)),
          },
          role: 'menu',
        }, ...menuItems) : null;

        return h('div', {
          ref: rootRef,
          className: 'pet-hud-root',
          'data-wander': wander ? '1' : '0',
          style: {
            ...(pos ? { left: pos.x + 'px', top: pos.y + 'px' } : { right: '28px', bottom: '132px' }),
            ...(wander ? { transform: 'translate(' + wander.x.toFixed(1) + 'px,' + wander.y.toFixed(1) + 'px)' } : {}),
          },
        }, pet, readout, menuEl);
      };
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.account'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'pet-hud',
        }, createPetHud(ctx)));
      },
    };
  },
});
