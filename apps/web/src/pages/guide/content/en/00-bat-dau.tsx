/*
 * English edition, chapter 00-bat-dau. Converted from the BA's static guide
 * (`public/guide/en/index.html`); this file is the source of truth now.
 */
import { GuideLink } from '../../ui/guide-link'
import {
  Audience,
  Callout,
  Eyebrow,
  Hero,
  HeroActions,
  HeroButton,
  HeroCopy,
  Lead,
  MetaStrip,
  PathCard,
  PathCopy,
  PathGrid,
  PathIcon,
  PreviewBody,
  PreviewCaption,
  PreviewCards,
  PreviewContext,
  PreviewLogo,
  PreviewTop,
  ReadingFlow,
  ScopePath,
  ScopePreview,
  Section,
  StarterCard,
  StarterGrid,
  StepBadge,
} from '../../ui/parts'

export default function Chapter() {
  return (
    <>
      <Hero id="gioi-thieu">
        <HeroCopy>
          <Eyebrow>PART 00 · GET STARTED</Eyebrow>
          <h1>Work in the right scope from the start</h1>
          <Lead>
            This guide helps you select the right Project and Team, manage Work Items, track
            progress, and administer Rova according to your permissions.
          </Lead>
          <HeroActions>
            <HeroButton variant="primary" hash="chon-lo-trinh">
              Choose what to read
            </HeroButton>{' '}
            <HeroButton variant="secondary" hash="truoc-khi-doc">
              Before you start
            </HeroButton>
          </HeroActions>
        </HeroCopy>
        <ScopePreview aria-label="Rova scope structure illustration">
          <PreviewTop>
            <PreviewLogo>QNSC</PreviewLogo> <PreviewContext>ROVA · TEAM</PreviewContext>
          </PreviewTop>
          <PreviewBody>
            <p>Currently selected scope</p>
            <ScopePath>
              <span>Workspace</span>
              <b>QNSC</b> <i aria-hidden="true">›</i> <span>Project</span>
              <b>Rova</b> <i aria-hidden="true">›</i> <span>Team</span>
              <b>Your team</b>
            </ScopePath>
            <PreviewCards aria-hidden="true">
              <span>
                <i />
                <i />
                <i />
              </span>{' '}
              <span>
                <i />
                <i />
              </span>
            </PreviewCards>
          </PreviewBody>
          <PreviewCaption>Check Project and Team before creating or updating tasks.</PreviewCaption>
        </ScopePreview>
      </Hero>
      <MetaStrip aria-label="Document version information">
        <div>
          <span>Product</span>
          <strong>ROVA</strong>
        </div>
        <div>
          <span>Document version</span>
          <strong>1.0</strong>
        </div>
        <div>
          <span>Language</span>
          <strong>Vietnamese / English</strong>
        </div>
        <div>
          <span>Format</span>
          <strong>User Guide</strong>
        </div>
      </MetaStrip>
      <Section
        id="truoc-khi-doc"
        number="00.1"
        title="Before you start"
        lead="Three things to help you avoid manipulating the wrong data or finding the wrong function."
        prose={false}
      >
        <StarterGrid>
          <StarterCard>
            <StepBadge>1</StepBadge>
            <h3>Check the selected scope</h3>
            <p>
              Look at the upper left corner and confirm it is correct{' '}
              <strong>Workspace · Project · Team</strong>. The Work Items you can see and the
              available Owners depend on this scope.
            </p>
          </StarterCard>
          <StarterCard>
            <StepBadge>2</StepBadge>
            <h3>Know your rights</h3>
            <p>
              You might be <strong>Workspace Admin</strong>, <strong>Admin</strong> of Project, or{' '}
              <strong>Editor</strong> in Team. Buttons and displayed data may vary.
            </p>
          </StarterCard>
          <StarterCard>
            <StepBadge>3</StepBadge>
            <h3>Select the correct target</h3>
            <p>
              Go from what you want to get done: create tasks, create plans, update Tasks, view
              reports, or administer. There is no need to read the entire document sequentially.
            </p>
          </StarterCard>
        </StarterGrid>
        <Callout>
          <strong>Permissions note</strong>
          <p>
            Role names such as PM, BA, Developer, or QA are not permission names in Rova.
            Operational permissions are determined by Workspace, Project and Team.
          </p>
        </Callout>
      </Section>
      <Section
        id="chon-lo-trinh"
        number="00.2"
        title="Choose a learning path"
        lead="Start with the work you need to do."
        prose={false}
      >
        <PathGrid empty="No matching topics were found in the current table of contents.">
          <PathCard keywords="novice workspace project team login">
            <PathIcon tone="blue">01</PathIcon>
            <PathCopy>
              <Audience>I'M NEW TO ROVA</Audience>
              <h3>Understand the system and get into the right scope</h3>
              <ul>
                <li>
                  <GuideLink to="01-lam-quen" hash="chapter-01">
                    01. Get acquainted with Rova <span>Read now</span>
                  </GuideLink>
                </li>
                <li>
                  <GuideLink to="02-truy-cap-pham-vi" hash="chapter-02">
                    02. Access & Scope <span>Read now</span>
                  </GuideLink>
                </li>
              </ul>
            </PathCopy>
          </PathCard>
          <PathCard keywords="daily work backlog user story defect iteration task team">
            <PathIcon tone="teal">02</PathIcon>
            <PathCopy>
              <Audience>I WORK IN ROVA DAILY</Audience>
              <h3>Create, plan, and execute work</h3>
              <ul>
                <li>
                  <GuideLink to="03-backlog-cong-viec" hash="chapter-03">
                    03. Backlog & Work Items <span>Read now</span>
                  </GuideLink>
                </li>
                <li>
                  <GuideLink to="04-testing" hash="chapter-04">
                    04. Testing with Test Case and Result <span>Read now</span>
                  </GuideLink>
                </li>
                <li>
                  <GuideLink to="05-lap-ke-hoach" hash="chapter-05">
                    05. Iteration Planning <span>Read now</span>
                  </GuideLink>
                </li>
                <li>
                  <GuideLink to="06-thuc-hien-cong-viec" hash="chapter-06">
                    06. Work Execution <span>Read now</span>
                  </GuideLink>
                </li>
                <li>
                  <GuideLink to="07-loi-theo-doi-team" hash="chapter-07">
                    07. Defects & Team Tracking <span>Read now</span>
                  </GuideLink>
                </li>
              </ul>
            </PathCopy>
          </PathCard>
          <PathCard keywords="delivery release management milestone portfolio capacity report">
            <PathIcon tone="violet">03</PathIcon>
            <PathCopy>
              <Audience>I MANAGE DELIVERY</Audience>
              <h3>Coordinate plans and read progress</h3>
              <ul>
                <li>
                  <GuideLink to="08-release-milestone" hash="chapter-08">
                    08. Release & Milestone
                  </GuideLink>
                </li>
                <li>
                  <GuideLink to="09-portfolio-capacity" hash="chapter-09">
                    09. Portfolio & Capacity
                  </GuideLink>
                </li>
                <li>
                  <GuideLink to="10-bao-cao" hash="chapter-10">
                    10. Reports
                  </GuideLink>
                </li>
              </ul>
            </PathCopy>
          </PathCard>
          <PathCard keywords="workspace admin admin user permissions project team support">
            <PathIcon tone="amber">05</PathIcon>
            <PathCopy>
              <Audience>I ADMINISTER ROVA</Audience>
              <h3>User management and working structure</h3>
              <ul>
                <li>
                  <GuideLink to="11-quan-tri-workspace" hash="chapter-11">
                    11. Workspace Administration
                  </GuideLink>
                </li>
                <li>
                  <GuideLink to="12-viet-backlog-item" hash="chapter-12">
                    12. Agile Guideline
                  </GuideLink>
                </li>
              </ul>
            </PathCopy>
          </PathCard>
        </PathGrid>
      </Section>
      <Section
        id="phuong-phap-doc"
        number="00.3"
        title="How to use each chapter"
        lead="Each chapter follows the same structure so you can scan and verify each task quickly."
        prose={false}
      >
        <ReadingFlow>
          <li>
            <span>01</span>
            <div>
              <strong>When to use</strong>
              <p>What this chapter helps you do.</p>
            </div>
          </li>
          <li>
            <span>02</span>
            <div>
              <strong>Before you start</strong>
              <p>Required permissions and data.</p>
            </div>
          </li>
          <li>
            <span>03</span>
            <div>
              <strong>Steps</strong>
              <p>Short steps in the correct order.</p>
            </div>
          </li>
          <li>
            <span>05</span>
            <div>
              <strong>Result</strong>
              <p>How to know if the operation was successful.</p>
            </div>
          </li>
          <li>
            <span>06</span>
            <div>
              <strong>Other scenarios</strong>
              <p>Common branches and how to handle them.</p>
            </div>
          </li>
        </ReadingFlow>
      </Section>
    </>
  )
}
