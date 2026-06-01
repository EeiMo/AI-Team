/**
 * components/NetworkBanner.tsx
 * WS 断线黄色横幅提示
 * - 依赖 useNetworkStore.isDegraded 控制显隐
 * - 固定于页面顶部，不随滚动
 */
import { useNetworkStore } from '../store';
import styles from './NetworkBanner.module.css';

export default function NetworkBanner() {
  const isDegraded = useNetworkStore((s) => s.isDegraded);

  if (!isDegraded) return null;

  return (
    <div className={styles.banner} role="alert">
      <span className={styles.icon}>⚠️</span>
      <span>网络连接中断，数据可能不是最新</span>
    </div>
  );
}
