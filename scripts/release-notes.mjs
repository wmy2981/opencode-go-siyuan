// 按 Conventional Commits 分类生成 Release 说明。
// 用法：node scripts/release-notes.mjs [起始 tag] [结束 ref]
//   起始 tag 省略时取全部历史；结束 ref 省略时取 HEAD。
// 仓库地址优先取 GITHUB_REPOSITORY，本地执行时回落到 origin。
import {execFileSync} from "node:child_process";

// Conventional Commits 类型 -> [小节标题前的 emoji, 说明小节标题]，
// emoji 与该类型的 gitmoji 约定一致；未列出的类型归入 Other Changes
const SECTIONS = new Map([
    ["feat", ["✨", "Features"]],
    ["fix", ["🐛", "Bug Fixes"]],
    ["perf", ["⚡", "Performance"]],
    ["revert", ["⏪️", "Reverts"]],
    ["refactor", ["♻️", "Refactoring"]],
    ["docs", ["📝", "Documentation"]],
    ["build", ["📦", "Build System"]],
    ["ci", ["👷", "Continuous Integration"]],
    ["test", ["✅", "Tests"]],
    ["style", ["💄", "Styles"]],
    ["chore", ["🔧", "Chores"]],
]);
const OTHER_SECTION = ["📌", "Other Changes"];
// 破坏性改动单独一节，排在所有类型之前：它在标题里（`type!:`）或正文里
// （`BREAKING CHANGE:` footer）任一处出现过都算，只列一次，不再重复进原类型小节
const BREAKING_SECTION = ["💥", "Breaking Changes"];
const BREAKING_SUBJECT = /^[a-z]+(?:\([^)]*\))?!:/;
const BREAKING_BODY = /^BREAKING[ -]CHANGE:/m;

// 版本号提交等无信息量的记录
const IGNORED_SUBJECTS = [
    /^chore(\([^)]*\))?!?:\s*bump\b/i,
    /^chore(\([^)]*\))?!?:\s*v?\d+\.\d+\.\d+/i,
    /^v?\d+\.\d+\.\d+$/,
];

const git = (...args) => execFileSync("git", args, {encoding: "utf8"}).trim();

const repository = () => {
    if (process.env.GITHUB_REPOSITORY) {
        return process.env.GITHUB_REPOSITORY;
    }
    return git("remote", "get-url", "origin").replace(/^.*[:/]([^/]+\/[^/]+?)(\.git)?$/, "$1");
};

const [fromTag, toRef = "HEAD"] = process.argv.slice(2);
const range = fromTag ? `${fromTag}..${toRef}` : toRef;

// --no-merges 同时排除分支合并与 PR 合并提交；正文只为找 BREAKING CHANGE footer
const commits = git("log", "--no-merges", "--format=%H%x1f%s%x1f%b%x1e", range)
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record !== "")
    .map((record) => {
        const [sha, subject, body = ""] = record.split("\x1f");
        return {sha, subject, body};
    });

const sections = new Map();
for (const {sha, subject, body} of commits) {
    if (IGNORED_SUBJECTS.some((pattern) => pattern.test(subject))) {
        continue;
    }
    // type(scope)!: description，不符合约定的提交原样归入 Other Changes
    const conventional = /^([a-z]+)(?:\(([^)]*)\))?!?:\s*(.+)$/.exec(subject);
    const type = conventional ? conventional[1] : "";
    const scope = conventional ? conventional[2] : "";
    const description = conventional ? conventional[3] : subject;
    const breaking = BREAKING_SUBJECT.test(subject) || BREAKING_BODY.test(body);
    const [emoji, title] = breaking ? BREAKING_SECTION : (SECTIONS.get(type) || OTHER_SECTION);
    const heading = `${emoji} ${title}`;
    const link = `([${sha.slice(0, 7)}](https://github.com/${repository()}/commit/${sha}))`;
    const entry = `- ${scope ? `**${scope}**: ` : ""}${description} ${link}`;
    sections.set(heading, [...(sections.get(heading) || []), entry]);
}

const orderedHeadings = [BREAKING_SECTION, ...SECTIONS.values(), OTHER_SECTION]
    .map(([emoji, title]) => `${emoji} ${title}`)
    .filter((heading) => sections.has(heading));
if (orderedHeadings.length === 0) {
    console.log("_No notable changes_");
} else {
    console.log(orderedHeadings.map((heading) => `### ${heading}\n\n${sections.get(heading).join("\n")}`).join("\n\n"));
}
