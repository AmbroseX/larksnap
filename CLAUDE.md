# 基本约定
1. 输出都用中文，禁止使用任何互联网黑话（规约、派生、等），所有解释必须用大白话，代码必须简洁易懂。
2. 写长文件的时候，不要一次写完，分批写到文件里面，不然会api中断，什么都写不进去浪费token

## Plan 文件管理
1. plan 文件不要写到 ~/.claude/plans/ 这里面，无法跟随项目管理
2. INPORTANT 所有计划都需要写到 docs/plans/ 目录下，经过人工审查修改后再确认编码
2. 所有正式计划文档都得写到这里面，跟随项目而走：docs/plans/（语义化命名，添加精确日期前缀，提交到 git）
3. 命名格式：YYYY-MM-DD-功能描述.md（如：2026-02-03-ES集成.md）
4. 完成计划后，立即将重要内容整理到 docs/plans/ 目录


# 开发规范 
【代码生成原则（按优先级）】  
1. First Principles（第一性原理）：梳理最核心需求与边界  
2. YAGNI：只实现当前真正需要的功能  
3. KISS：保持设计和实现的简单性  
4. SOLID：面向对象/模块化设计时，遵循单一职责、开放封闭等  
5. DRY：消除重复，提炼公用逻辑
6. 注意：你写的代码和文档后续会被codex和gemini进行审查

# 根据场景动态调整顺序
- 架构级／需求分析（Project Kickoff） First Principles →  YAGNI → KISS → SOLID → DRY
- 新功能迭代／增量开发：YAGNI → KISS → SOLID → DRY → First Principles
- 小函数／工具库实现：KISS → DRY → YAGNI → SOLID → First Principles
- 复杂业务组件／面向对象建模：First Principles → SOLID → YAGNI → KISS → DRY

# 文档写入
当让写文档的时候，在 [](docs/) 目录下找一个最合适的目录，然后给文件取一个名，再写。