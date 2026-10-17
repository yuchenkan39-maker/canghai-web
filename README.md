# 季沧海助手 · 网页版

**打开：https://yuchenkan39-maker.github.io/canghai-web/**

T790 · T786 · PJ01 · PJ02 实时位置、到站倒计时和打球下雨指数。手机浏览器打开后「添加到主屏幕」即可像 App 一样使用。

- 实时位置直接来自 Rapid Bus 的实时推送（myrapidbus kiosk 页面用的同一个数据源），每 5 秒刷新
- ⭐ 常用站：PJ212 Jaya One Mall（对面）、PJ258 PPUM
- 出发提醒：网页开着时，车离站 N 分钟弹通知并响提示音（锁屏后台提醒请用 Android App）
- 打球指数：Open-Meteo 预报按梳邦站两年多实况校准，加 MET Malaysia 警报、空气质量、体感温度和 RainViewer 雷达临近预报

纯静态页面，所有数据由浏览器直接从公开来源获取，没有服务器。源码在 `site/`，逻辑与 Android 版一致（`site/js/core.js`）。
地图 © OpenStreetMap 贡献者 · 雷达 RainViewer。
