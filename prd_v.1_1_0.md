Opinion HUD V1.1.0

1. 数据迁移到个人域名下：opinionhud.xyz。数据为 opinionhud.xyz/data.json。
结果：已修改。
2. github action 由于 runner 在美区，而 Opinion 官方 API 仅限日韩区使用，所以 action build 时使用中转API：
   - http://opinion.api.predictscan.dev:10001/api/markets (主要 markets 数据)
   - https://opinionanalytics.xyz/api/markets/wrap-events (父事件数据，用于获取多选市场的 cutoffAt)
   - 未直接集成 Opinion 官方 API
3. 在插件前端页面调用 wrapped-event和YES/NO 的价格的时候，改用部署在自己的vercel服务的无状态函数来中转，该vercel服务的地区位于日本，因此应该可以打到opinion的官方API。
4. 上线官方网站，增加插件的下载位置（chrome商店链接），优化前端页面，也可以加入一些查询功能。
5. chrome是否要读取用户浏览记录？这个是做什么的？
6. 前端插件除了英文外，要支持中文关键词匹配。例如 FOMC -> 降息，Russia VS Ukraine -> 俄乌战争，俄罗斯，乌克兰
7. 显示YES的历史价格。以及该推文发送时的价格在K线上的位置。