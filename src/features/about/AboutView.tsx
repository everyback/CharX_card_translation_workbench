import {
  BookOpen,
  CheckCircle2,
  ExternalLink,
  FileCode2,
  LockKeyhole,
  MessageCircle,
  Server,
  ShieldCheck,
  Users,
} from 'lucide-react';

const workflow = ['导入卡片或模块', '选择翻译范围', '扫描并执行翻译', '人工检查高疑点内容', '生成审核稿并导出'];

export function AboutView() {
  return (
    <section className="about-page" aria-labelledby="about-title">
      <div className="about-hero">
        <div className="about-hero-icon"><LanguagesMark /></div>
        <div>
          <p className="about-eyebrow">项目说明</p>
          <h2 id="about-title">卡片翻译工作台</h2>
          <p className="about-lead">目的是成为一个全面，优雅，灵活而又严谨的卡片翻译工具。</p>
        </div>
      </div>

      <div className="about-grid">
        <article className="about-card about-card-wide">
          <div className="about-card-title"><BookOpen size={18} /><h3>项目做什么</h3></div>
          <p>卡片里的世界书、Lua、正则和资源经常互相交错，直接全文翻译很容易破坏原有按钮和脚本的格式。工作台会先把这些内容分开并保护起来，再让模型生成草稿，最后由你在审核页确认哪些修改可以导出。原卡片和聊天记录都不会被自动改动。绝大部分情况下可以无脑全部通过。</p>
          <div className="about-workflow">
            {workflow.map((item, index) => <div className="about-workflow-step" key={item}><b>{index + 1}</b><span>{item}</span></div>)}
          </div>
        </article>

        <article className="about-card">
          <div className="about-card-title"><Users size={18} /><h3>作者说明</h3></div>
          <p>本项目面向需要处理复杂角色卡的使用者，优先保证格式安全、结果可回退和人工确认。模型输出仅作为翻译候选，不代表最终结果；导出前应自行核对协议、脚本、触发词和资源引用。</p>
          <p className="about-muted">问题反馈请提供脱敏日志和最小复现样例。请勿提交真实卡片、聊天记录、API Key 或本机路径。</p>
        </article>

        <article className="about-card">
          <div className="about-card-title"><FileCode2 size={18} /><h3>Git 项目说明</h3></div>
          <p>仓库包含前端工作台、后端 API、卡片格式解析器、翻译调度和回归测试。项目主要针对 RisuAI 模块与 CHARX 卡片，相关流程经过较充分测试；PNG、普通 JSON 等酒馆卡格式目前只有基础兼容，测试覆盖不足。新增格式或保护规则应同时补充回归测试。</p>
          <div className="about-links">
            <span><ExternalLink size={14} />公开仓库地址将在正式发布时补上</span>
            <span><FileCode2 size={14} />TypeScript + React + Fastify + SQLite</span>
          </div>
        </article>

        <article className="about-card">
          <div className="about-card-title"><ShieldCheck size={18} /><h3>安全与隐私</h3></div>
          <ul className="about-list">
            <li><LockKeyhole size={15} />API Key 只在后端使用，不返回浏览器。</li>
            <li><Server size={15} />默认绑定 127.0.0.1，不提供公网服务。</li>
            <li><CheckCircle2 size={15} />导出前保留原文、译文和审核状态供对比。</li>
          </ul>
        </article>

        <article className="about-card">
          <div className="about-card-title"><MessageCircle size={18} /><h3>参与项目</h3></div>
          <p>纯正的vibe coding产物，断断续续拷打了数周GPT-5.6sol。没有任何的人工介入代码，所以作者根本看不懂写了啥，有bug很正常，祈祷不要报错就好。</p>
          <p>参与开发前请先阅读 README、AGENTS.md 和部署说明。提交问题或代码时，必须移除真实卡片、API Key、聊天记录和本机路径，并补充必要的复现信息。</p>
          <p className="about-muted">项目不提供登录功能，定位为个人电脑或受控内网中的本地工具，请勿绑定0.0.0.0或者公网端口。</p>
        </article>
      </div>
    </section>
  );
}

function LanguagesMark() {
  return <span aria-hidden="true">文</span>;
}
