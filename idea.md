写一个基于ts和pi agent的自动化agent脚本用于收集arixv上面的论文（从papers.cool上爬取cs.LG, cs.CL, cs.AI，category可设置），然后以周为单位生成一个digest，只保留我想要的相关论文（参考config.yaml设计）。要求做好各种缓存（包括paper abstract缓存和llm打分的缓存），然后输出格式是一个markdown，包括：1.title 2. 类别 3.tag（category细分结果，optional，这个由agent自己决定） 4. abstract。

具体分为以下三个部分：

1. 收集论文信息，包括标题、类别、标签、摘要等，并进行缓存处理。这个可以选择从 arxiv API 或者 papers.cool 上爬取数据。
2. 对收集到的论文进行分类。这个步骤使用 LLM 进行判断。LLM需要使用TOPICS.yaml里面的分类，将所有论文按照category进行分类（请考虑现在的topic分类是否完善，怎么让LLM自动化运行，怎么让LLM尽可能正确分类）。同时LLM还需要生成一个简短的TLDR（简体中文）来概括每篇论文的内容。分类结果和TLDR也需要进行缓存处理，以便后续使用。
3. 输出展示分类结果。这个部分先使用markdown格式输出，每周的每个category生成一个md。包括标题、link to arixv/papers.cool(e.g. https://papers.cool/arxiv/2604.21100)、标签、作者、中文tldr、摘要。在整个代码实现完毕后，再进一步开始考虑使用html和css进行美化展示。
