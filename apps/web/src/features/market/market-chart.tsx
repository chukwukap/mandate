"use client";
import {
  CandlestickSeries,
  CrosshairMode,
  createChart,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  LineSeries,
  LineStyle,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { type Candle, type CandleInterval, useCandles } from "./use-candles";

/**
 * The price chart, drawn from observed Aerodrome trades.
 *
 * lightweight-charts rather than the hand-rolled SVG next door, because the things that make a
 * chart usable — a crosshair that snaps to a candle, a price scale that stays readable while you
 * zoom, panning that does not redraw the world — are the whole library, and reimplementing them
 * badly is worse than not having them.
 *
 * The SVG DeskChart stays for the compact sparklines. A page of market rows renders eight of them,
 * and eight chart engines to draw eight 90px trend lines is a cost with nothing bought by it.
 *
 * # Colours come from the stylesheet, not from here
 *
 * Every colour is read from the `--desk-*` custom properties at mount, so the chart follows the
 * theme the rest of the page uses instead of carrying a second palette that drifts. The library
 * cannot read CSS variables itself — it paints to a canvas — so they are resolved once and
 * re-resolved when the theme attribute changes.
 */

const MA_PERIOD = 20;

/**
 * A price range that ignores artifact prints without deleting them.
 *
 * These pools print the occasional trade at a price no market made. Measured on NVDAc's daily
 * candles: 2026-08-18 opens at 224.16 and closes at 221.06 with a high of 495.47 — one trade
 * into a thin tick spacing, the same failure mode that makes the AAPLc spacing-200 pool quote
 * $37,861 a share. Autoscaling to it puts a $230 stock on a $500 axis and squashes three weeks
 * of real movement into a band a few pixels tall.
 *
 * So the DEFAULT view is scaled to a band around the median close. Outliers are still drawn and
 * still there when you zoom or pan — nothing is filtered out of the data — but they no longer
 * decide how everything else is displayed. Hiding them would be a lie; letting them set the
 * scale makes the chart useless.
 */
function robustRange(candles: Candle[]) {
  const closes = candles.map((c) => c.close).sort((a, b) => a - b);
  if (!closes.length) return null;

  // Anchored on the MEDIAN CLOSE, not on a trimmed count of highs and lows.
  //
  // Trimming a fixed count was the second wrong answer to this. `max(1, floor(n * 0.02))` drops
  // exactly one point per end for any window from 10 to 99 candles, and nothing at all below 10
  // — so it survives a single artifact wick and nothing more. Measured across all 7 assets and
  // 5 intervals: 15 of the 35 charts still autoscaled to between 2x and 56x the traded range,
  // because these young pools routinely print two or more bad candles in a row. GOOGLc's daily
  // series has adjacent artifacts at 38,522.82 and 5,021.36, which defeats any single-point
  // trim, and MSFTc drew Microsoft at $1,978 on an axis running from -$400 to $2,000.
  //
  // Closes are the honest centre: a wick is one trade at a price nobody else accepted, but a
  // close is where the pool actually settled. Everything within a wide band around the median
  // close sets the scale; anything outside it is still drawn and still reachable by zooming,
  // but no longer decides how the rest of the series is displayed.
  const median = closes[Math.floor(closes.length / 2)] as number;
  if (!(median > 0)) return null;
  // Deliberately generous. This is an outlier guard, not a volatility model, and a real 3x move
  // in a young market must never be squashed by it.
  const ceiling = median * 4;
  const floor = median / 4;
  const within = (value: number) => value >= floor && value <= ceiling;

  const lows = candles.map((c) => c.low).filter(within);
  const highs = candles.map((c) => c.high).filter(within);
  // If the band excluded everything — a series with no coherent centre — fall back to the
  // closes, which by construction contain the median and so can never be empty.
  const low = Math.min(...(lows.length ? lows : closes));
  const high = Math.max(...(highs.length ? highs : closes));
  if (!(high > low)) return null;
  const pad = (high - low) * 0.08;
  // Prices are non-negative. Padding a low near zero must not put a negative dollar on the axis.
  return { minValue: Math.max(0, low - pad), maxValue: high + pad };
}

function readTheme(element: HTMLElement) {
  const style = getComputedStyle(element);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: token("--desk-surface", "#ffffff"),
    text: token("--desk-muted", "#5c6472"),
    grid: token("--desk-chart-grid", "#dfe4ea"),
    border: token("--desk-line", "#d6dbe2"),
    up: token("--desk-green", "#14794f"),
    down: token("--desk-red", "#b3382f"),
    average: "#b9974f",
  };
}

/** A simple moving average, undefined until it has enough closes to be one. */
function movingAverage(candles: Candle[], period: number) {
  const out: { time: UTCTimestamp; value: number }[] = [];
  let sum = 0;
  for (const [index, candle] of candles.entries()) {
    sum += candle.close;
    if (index >= period) sum -= candles[index - period]?.close ?? 0;
    // Emitting a partial average for the first nineteen candles would draw a line that bends
    // toward the series as the window fills — a shape produced by the arithmetic, not the market.
    if (index >= period - 1) out.push({ time: candle.time as UTCTimestamp, value: sum / period });
  }
  return out;
}

export function MarketChart({
  symbol,
  interval,
  type = "candles",
  average = false,
  height = 320,
}: {
  symbol: string;
  interval: CandleInterval;
  type?: "candles" | "line";
  average?: boolean;
  height?: number;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const price = useRef<ISeriesApi<"Candlestick"> | ISeriesApi<"Line"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const mean = useRef<ISeriesApi<"Line"> | null>(null);
  const [hovered, setHovered] = useState<Candle | null>(null);
  const { candles, error } = useCandles(symbol, interval);
  /** Read by the autoscale provider, which the library calls outside React's render. */
  const latest = useRef<Candle[]>([]);

  // Rebuilt when the series TYPE changes because a candlestick and a line are different series
  // objects; everything else updates the existing chart in place.
  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    const theme = readTheme(element);

    const instance = createChart(element, {
      height,
      layout: {
        background: { color: theme.background },
        textColor: theme.text,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: theme.grid, style: LineStyle.Dotted },
        horzLines: { color: theme.grid, style: LineStyle.Dotted },
      },
      rightPriceScale: { borderColor: theme.border, scaleMargins: { top: 0.08, bottom: 0.26 } },
      timeScale: { borderColor: theme.border, timeVisible: true, secondsVisible: false },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: theme.text,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: theme.text,
        },
        horzLine: {
          color: theme.text,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: theme.text,
        },
      },
      localization: { priceFormatter: (value: number) => `$${value.toFixed(2)}` },
      autoSize: false,
    });

    // Recomputed from the data each time the library asks, so it follows a symbol or interval
    // change without the series being rebuilt.
    const autoscaleInfoProvider = () => {
      const range = robustRange(latest.current);
      return range ? { priceRange: range } : null;
    };

    price.current =
      type === "candles"
        ? instance.addSeries(CandlestickSeries, {
            autoscaleInfoProvider,
            upColor: theme.up,
            downColor: theme.down,
            borderUpColor: theme.up,
            borderDownColor: theme.down,
            wickUpColor: theme.up,
            wickDownColor: theme.down,
          })
        : instance.addSeries(LineSeries, { autoscaleInfoProvider, color: theme.up, lineWidth: 2 });

    // Volume shares the pane but not the scale, pinned to the bottom quarter. On its own scale it
    // would rescale the price series every time a single bar spiked.
    volume.current = instance.addSeries(HistogramSeries, {
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      // Without these the volume series prints its last value on the price axis, formatted by
      // the chart's price formatter — "$1286774.39" sitting among the share prices.
      lastValueVisible: false,
      priceLineVisible: false,
    });
    instance.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    mean.current = instance.addSeries(LineSeries, {
      color: theme.average,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    instance.subscribeCrosshairMove((param) => {
      // Resolved against the source data by time rather than read out of the series.
      //
      // A line series yields {time, value}, not {open, high, low, close}. Casting that to a
      // Candle made the legend call `shown.open.toFixed(2)` on undefined, which throws during
      // render and unmounts the whole page — hovering the line chart was a hard crash, not a
      // blank legend. Looking the candle up by time fixes the crash and is also better: the
      // line chart now gets a real OHLC legend instead of the closes it was drawn from.
      const time = param.time === undefined ? undefined : Number(param.time);
      setHovered(time === undefined ? null : (latest.current.find((c) => c.time === time) ?? null));
    });

    chart.current = instance;
    const resize = () => instance.applyOptions({ width: element.clientWidth });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);

    return () => {
      observer.disconnect();
      instance.remove();
      chart.current = null;
      price.current = null;
      volume.current = null;
      mean.current = null;
    };
  }, [type, height]);

  useEffect(() => {
    if (!chart.current || !price.current || !candles?.length) return;
    const theme = readTheme(holder.current as HTMLElement);
    // Set BEFORE setData: the library computes the autoscale synchronously inside setData and
    // asks the provider for a range then. Assigning this during render instead let an empty
    // array reach the first call, so the provider returned null and the default autoscale —
    // the one that puts a $230 stock on a $500 axis — was used.
    // The library asserts on a repeated or out-of-order timestamp, and an assertion here is not a
    // blank chart — it is the whole page replaced by the error boundary. The API sends one
    // candle per bucket; this is the guarantee restated where the failure would land.
    const series = candles
      .slice()
      .sort((a, b) => a.time - b.time)
      .filter((c, i, all) => i === 0 || c.time > (all[i - 1] as { time: number }).time);
    latest.current = series;

    if (type === "candles") {
      (price.current as ISeriesApi<"Candlestick">).setData(
        series.map((c) => ({ ...c, time: c.time as UTCTimestamp })),
      );
    } else {
      (price.current as ISeriesApi<"Line">).setData(
        series.map((c) => ({ time: c.time as UTCTimestamp, value: c.close })),
      );
    }

    volume.current?.setData(
      series.map((c) => ({
        time: c.time as UTCTimestamp,
        value: c.volume,
        // Tinted by the candle's own direction, so the volume row reads as part of the price
        // rather than a separate series that happens to sit underneath it.
        color: `${c.close >= c.open ? theme.up : theme.down}33`,
      })),
    );
    mean.current?.setData(average ? movingAverage(series, MA_PERIOD) : []);
    chart.current.timeScale().fitContent();
  }, [candles, type, average]);

  const last = candles?.[candles.length - 1];
  const shown = hovered ?? last;
  const change = shown ? ((shown.close - shown.open) / shown.open) * 100 : 0;

  return (
    <div className="market-chart">
      <div className="market-chart-legend" aria-live="polite">
        {shown ? (
          <>
            <span>
              O <b>{shown.open.toFixed(2)}</b>
            </span>
            <span>
              H <b>{shown.high.toFixed(2)}</b>
            </span>
            <span>
              L <b>{shown.low.toFixed(2)}</b>
            </span>
            <span>
              C <b>{shown.close.toFixed(2)}</b>
            </span>
            <span className={change >= 0 ? "desk-positive" : "desk-negative"}>
              {change >= 0 ? "+" : ""}
              {change.toFixed(2)}%
            </span>
          </>
        ) : (
          <span>{error ?? (candles ? "No trades in this window." : "Loading price history…")}</span>
        )}
      </div>
      <div ref={holder} className="market-chart-canvas" style={{ height }} />
      {/* Named rather than implied: these are pool trades on Aerodrome, not the Chainlink
          reference and not the equity's primary exchange, and the difference matters to anyone
          comparing this against a broker screen. */}
      <div className="market-chart-foot">
        <span>
          <i className="base-dot" />
          {symbol} / USDC · Aerodrome · observed trades
        </span>
        {error && candles ? <span className="desk-muted">Showing the last good data</span> : null}
      </div>
    </div>
  );
}
