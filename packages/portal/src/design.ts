import type { CSSProperties } from 'react';
import type { ThemeConfig } from 'antd';

const colors = {
  ink: '#102A43', brand: '#126D74', canvas: '#F4F7FA', surface: '#FFFFFF', muted: '#526574', border: '#D9E2EC',
  accent: '#74DED3', soft: '#EDF5F5', success: '#24744B', warning: '#936316', error: '#B43E45', info: '#206A94',
} as const;
const fontFamily = '"Segoe UI Variable", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

// One palette feeds the AntD theme and scoped CSS variables; no external font or asset requests.
export const designVariables = Object.fromEntries(Object.entries(colors).map(([key, value]) => [`--iv-${key}`, value])) as CSSProperties;
export const portalTheme: ThemeConfig = {
  token: { colorPrimary: colors.brand, colorText: colors.ink, colorTextSecondary: colors.muted, colorBgLayout: colors.canvas,
    colorBgContainer: colors.surface, colorBorder: colors.border, colorSuccess: colors.success, colorWarning: colors.warning,
    colorError: colors.error, colorInfo: colors.info, fontFamily, borderRadius: 8, controlHeight: 40, fontSize: 14 },
  components: {
    Card: { paddingLG: 24, headerFontSize: 16 },
    Table: { headerBg: '#EDF2F6', headerColor: colors.muted, rowHoverBg: '#F1F6F8', cellPaddingBlock: 16 },
    Modal: { titleFontSize: 20 },
  },
};
