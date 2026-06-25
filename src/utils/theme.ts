// Theme utility functions for consistent styling across the app

export interface ThemeColors {
  background: string;
  cardBg: string;
  border: string;
  text: string;
  textSecondary: string;
  backdropFilter: string;
  shadow: string;
  hoverBg: string;
}

export const getThemeColors = (
  isDarkMode: boolean,
  hasWallpaper: boolean,
): ThemeColors => {
  if (hasWallpaper) {
    // Wallpaper mode - semi-transparent with blur
    return {
      background: isDarkMode ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.4)',
      cardBg: isDarkMode ? 'rgba(31,31,31,0.7)' : 'rgba(255,255,255,0.7)',
      border: isDarkMode ? 'rgba(48,48,48,0.8)' : 'rgba(240,240,240,0.8)',
      text: isDarkMode ? '#fff' : '#000',
      textSecondary: isDarkMode ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)',
      backdropFilter: 'blur(20px) saturate(1.5)',
      shadow: isDarkMode
        ? '0 2px 8px rgba(0,0,0,0.3)'
        : '0 2px 8px rgba(0,0,0,0.1)',
      hoverBg: isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)',
    };
  } else {
    // Normal mode - solid colors
    return {
      background: isDarkMode ? '#141414' : '#f5f5f5',
      cardBg: isDarkMode ? '#1f1f1f' : '#ffffff',
      border: isDarkMode ? '#303030' : '#f0f0f0',
      text: isDarkMode ? '#fff' : '#000',
      textSecondary: isDarkMode ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)',
      backdropFilter: 'none',
      shadow: isDarkMode
        ? '0 2px 8px rgba(0,0,0,0.15)'
        : '0 2px 8px rgba(0,0,0,0.08)',
      hoverBg: isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)',
    };
  }
};

export const getCardStyle = (
  isDarkMode: boolean,
  hasWallpaper: boolean,
): React.CSSProperties => {
  const colors = getThemeColors(isDarkMode, hasWallpaper);
  return {
    background: colors.cardBg,
    borderColor: colors.border,
    backdropFilter: colors.backdropFilter,
    WebkitBackdropFilter: colors.backdropFilter,
    boxShadow: colors.shadow,
  };
};

export const getTableStyle = (
  isDarkMode: boolean,
  hasWallpaper: boolean,
): React.CSSProperties => {
  const colors = getThemeColors(isDarkMode, hasWallpaper);
  return {
    background: colors.cardBg,
    backdropFilter: colors.backdropFilter,
    WebkitBackdropFilter: colors.backdropFilter,
  };
};
