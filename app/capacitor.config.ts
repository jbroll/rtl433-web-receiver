import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.rkroll.rtl433',
  appName: 'rtl_433',
  webDir: '../dashboard/dist',
  android: {
    path: 'android',
  },
  ios: {
    path: 'ios',
  },
  server: {
    androidScheme: 'http',
  },
};

export default config;
