/**
 * components/ResultChart.tsx
 * ECharts 横向柱状图：票数/百分比、乐观更新、匿名/实名区分、响应式（U-03 优化）
 *
 * v3 优化：
 * - 卡片式结果容器（圆角 12px, 阴影, 内边距）
 * - 动画 duration: 300ms, easing: cubicOut
 * - 标题 + 更新时间戳
 * - 渐变/圆角进度条
 * - 本端已选项区分色
 */
import { useRef, useEffect, useMemo, useState } from 'react';
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
  optimisticCounts: Record<string, number>;
  /** 当前用户所选 option IDs（用于高亮本端已选项） */
  mySelectedOptions?: string[];
  /** 是否有新投票（用于脉冲高亮动效） */
  highlightOptionId?: string | null;
}

export default function ResultChart({
  options,
  voteMode,
  status,
  optimisticCounts,
  mySelectedOptions = [],
  highlightOptionId,
}: ResultChartProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<echarts.ECharts | null>(null);
  // 用于显示「刚刚更新」时间戳
  const [lastUpdate, setLastUpdate] = useState<string>('');

  const isAnonymous = voteMode === 'anonymous';
  const isClosed = status === 'closed';
  const title = isClosed ? '最终结果' : '实时结果';

  // 计算展示数据（含乐观偏移）
  const chartData = useMemo(() => {
    return options.map((opt) => ({
      name: opt.content,
      value: (opt.count ?? 0) + (optimisticCounts[opt.id] ?? 0),
      voters: opt.voters ?? [],
      id: opt.id,
    }));
  }, [options, optimisticCounts]);

  const totalVotes = chartData.reduce((sum, d) => sum + d.value, 0);

  // 更新「刚刚更新」时间戳
  useEffect(() => {
    if (Object.keys(optimisticCounts).length > 0) {
      setLastUpdate('刚刚更新');
      const timer = setTimeout(() => {
        setLastUpdate(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [optimisticCounts, totalVotes]);

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
        textStyle: { fontSize: 14, fontWeight: 600, color: '#1d1d1f' },
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: unknown) => {
          const p = (params as { name: string; value: number }[])[0];
          const percent = totalVotes > 0 ? ((p.value / totalVotes) * 100).toFixed(1) : '0';
          const dataItem = chartData.find((d) => d.name === p.name);
          let votersInfo = '';
          if (!isAnonymous && dataItem && dataItem.voters.length > 0) {
            votersInfo = '<br/>投票人：' + dataItem.voters.map((v) => v.user_name).join('、');
          }
          // 是否为本端已选项
          const isMine = dataItem && mySelectedOptions.includes(dataItem.id);
          const mineTag = isMine ? '<br/><span style="color:#3370FF">✓ 你已选此项</span>' : '';
          return `${p.name}<br/>票数：<b>${p.value}</b>（${percent}%）${votersInfo}${mineTag}`;
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
          animationDuration: 300,
          animationEasing: 'cubicOut',
          data: chartData.map((d) => ({
            value: d.value,
            itemStyle: {
              color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
                { offset: 0, color: mySelectedOptions.includes(d.id) ? '#2b5fd9' : '#3370FF' },
                { offset: 1, color: mySelectedOptions.includes(d.id) ? '#4a7ae8' : '#5b8cff' },
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
  }, [chartData, title, totalVotes, isAnonymous, isClosed, mySelectedOptions]);

  // 组件卸载时销毁实例
  useEffect(() => {
    return () => {
      instanceRef.current?.dispose();
      instanceRef.current = null;
    };
  }, []);

  return (
    <div className={styles.resultCard}>
      <div className={styles.resultHeader}>
        <h3 className={styles.resultTitle}>{title}</h3>
        <span className={styles.updateTime}>
          {lastUpdate || new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      <div ref={chartRef} className={styles.chart} />
      <p className={styles.summary}>
        共 <strong className={styles.totalCount}>{totalVotes}</strong> 票
        {isAnonymous && !isClosed && (
          <span className={styles.anonymousHint}>(匿名模式)</span>
        )}
      </p>
    </div>
  );
}
