/**
 * components/ResultChart.tsx
 * ECharts 横向柱状图：票数/百分比、乐观更新、匿名/实名区分、响应式
 *
 * 按需引入：仅 bar 模块（echarts/core + BarChart + 必要组件）
 * 乐观更新：optimisticCounts[option_id] 为本地偏移量，叠加到 count 上
 * 匿名区分：anonymous=true 时不渲染投票人信息
 */
import { useRef, useEffect, useMemo } from 'react';
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import {
  TitleComponent,
  TooltipComponent,
  GridComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { Option as OptionType, VoteMode, VoteStatus } from '../types';
import styles from './ResultChart.module.css';

// 按需注册
echarts.use([BarChart, TitleComponent, TooltipComponent, GridComponent, CanvasRenderer]);

interface ResultChartProps {
  options: OptionType[];
  voteMode: VoteMode;
  status: VoteStatus;
  optimisticCounts: Record<string, number>; // option_id → 偏移量
}

export default function ResultChart({
  options,
  voteMode,
  status,
  optimisticCounts,
}: ResultChartProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<echarts.ECharts | null>(null);

  const isAnonymous = voteMode === 'anonymous';
  const isClosed = status === 'closed';
  const title = isClosed ? '最终结果' : '实时结果';

  // 计算展示数据（含乐观偏移）
  const chartData = useMemo(() => {
    return options.map((opt) => ({
      name: opt.content,
      value: (opt.count ?? 0) + (optimisticCounts[opt.id] ?? 0),
      voters: opt.voters ?? [],
    }));
  }, [options, optimisticCounts]);

  const totalVotes = chartData.reduce((sum, d) => sum + d.value, 0);

  // 初始化/更新图表
  useEffect(() => {
    if (!chartRef.current) return;

    if (!instanceRef.current) {
      instanceRef.current = echarts.init(chartRef.current, undefined, {
        renderer: 'canvas',
      });
    }

    const instance = instanceRef.current;

    const option = {
      title: {
        text: title,
        left: 'center',
        top: 0,
        textStyle: { fontSize: 14, fontWeight: 500, color: '#666' },
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: unknown) => {
          const p = (params as { name: string; value: number }[])[0];
          const percent = totalVotes > 0 ? ((p.value / totalVotes) * 100).toFixed(1) : '0';
          // 实名 + 已结束 = 展示投票人
          const dataItem = chartData.find((d) => d.name === p.name);
          let votersInfo = '';
          if (!isAnonymous && dataItem && dataItem.voters.length > 0) {
            votersInfo = '<br/>投票人：' + dataItem.voters.map((v) => v.user_name).join('、');
          }
          return `${p.name}<br/>票数：<b>${p.value}</b>（${percent}%）${votersInfo}`;
        },
      },
      grid: {
        left: '3%',
        right: '15%',
        top: 36,
        bottom: '3%',
        containLabel: true,
      },
      xAxis: {
        type: 'value',
        minInterval: 1,
        axisLabel: { fontSize: 12, color: '#999' },
        splitLine: { lineStyle: { color: '#f0f0f0' } },
      },
      yAxis: {
        type: 'category',
        data: chartData.map((d) => d.name),
        axisLabel: {
          fontSize: 13,
          color: '#333',
          width: 120,
          overflow: 'truncate',
        },
        axisLine: { show: false },
        axisTick: { show: false },
        inverse: true,
      },
      series: [
        {
          name: '票数',
          type: 'bar',
          data: chartData.map((d) => ({
            value: d.value,
            itemStyle: {
              color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
                { offset: 0, color: '#3370FF' },
                { offset: 1, color: '#5b8cff' },
              ]),
              borderRadius: [0, 4, 4, 0],
            },
          })),
          barMaxWidth: 32,
          label: {
            show: true,
            position: 'right',
            formatter: (params: unknown) => {
              const p = params as { value: number };
              const percent = totalVotes > 0 ? ((p.value / totalVotes) * 100).toFixed(1) : '0';
              return `${p.value}票 ${percent}%`;
            },
            fontSize: 12,
            color: '#666',
          },
        },
      ],
    };

    instance.setOption(option, true);

    // 响应式
    const handleResize = () => instance.resize();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [chartData, title, totalVotes, isAnonymous, isClosed]);

  // 组件卸载时销毁实例
  useEffect(() => {
    return () => {
      instanceRef.current?.dispose();
      instanceRef.current = null;
    };
  }, []);

  return (
    <div className={styles.container}>
      <div ref={chartRef} className={styles.chart} />
      <p className={styles.summary}>
        共 <strong>{totalVotes}</strong> 票
        {isAnonymous && !isClosed && (
          <span className={styles.anonymousHint}>（匿名模式，不显示投票人身份）</span>
        )}
      </p>
    </div>
  );
}
