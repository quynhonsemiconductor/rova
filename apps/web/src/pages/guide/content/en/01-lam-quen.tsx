/*
 * English edition, chapter 01-lam-quen. Converted from the BA's static guide
 * (`public/guide/en/01-lam-quen.html`); this file is the source of truth now.
 */
import {
  Callout,
  ChapterEyebrow,
  ChapterIntro,
  ChapterSummary,
  CheckUnderstanding,
  DefinitionGrid,
  DocTable,
  Lead,
  ObjectLabel,
  PlanningGrid,
  PlanningIcon,
  PlanningQuestion,
  ScenarioBadge,
  ScenarioCard,
  ScenarioFlow,
  ScenarioHead,
  ScenarioPlanning,
  ScenarioScope,
  ScopeLeadFollow,
  ScopeLeadPath,
  ScopeLevel,
  ScopeLevels,
  Section,
  TreeConnector,
  TreeRow,
  TypeChip,
  WorkTree,
} from '../../ui/parts'

export default function Chapter() {
  return (
    <>
      <ChapterIntro id="chapter-01">
        <div>
          <ChapterEyebrow>PART 01 · GETTING FAMILIARIZED</ChapterEyebrow>
          <h2>Understand the structure before starting work</h2>
          <Lead>
            Rova organizes data in three coverage classes:{' '}
            <ScopeLeadPath>Workspace → Project → Team</ScopeLeadPath>{' '}
            <ScopeLeadFollow>
              The system then uses different object types to describe goals, tasks, and delivery
              plans.
            </ScopeLeadFollow>
          </Lead>
        </div>
        <ChapterSummary aria-label="After this section you will understand">
          <strong>After this, you will understand</strong>
          <ul>
            <li>In what scope am I working?</li>
            <li>How are Epic, Feature, US, DE and Task different?</li>
            <li>What are Iteration, Release and Milestone used for?</li>
            <li>How is access different from creator and owner?</li>
          </ul>
        </ChapterSummary>
      </ChapterIntro>
      <Section
        id="pham-vi-lam-viec"
        number="01.1"
        title="Three layers of work scope"
        lead="The scope being selected determines what data you see and who can be selected as Owner."
      >
        <ScopeLevels aria-label="Workspace, Project and Team structure">
          <article>
            <ScopeLevel>01</ScopeLevel>
            <div>
              <ObjectLabel>COMPANY SCOPE</ObjectLabel>
              <h3>Workspace</h3>
              <p>Common space of the organization. Workspace contains users and Projects.</p>
              <small>
                For example: <strong>QNSC</strong>
              </small>
            </div>
          </article>
          <article>
            <ScopeLevel>02</ScopeLevel>
            <div>
              <ObjectLabel>PRODUCT SCOPE</ObjectLabel>
              <h3>Project</h3>
              <p>
                A place where the work, plans, and reports of a product or initiative come together.
              </p>
              <small>
                For example: <strong>Rova</strong>
              </small>
            </div>
          </article>
          <article>
            <ScopeLevel>03</ScopeLevel>
            <div>
              <ObjectLabel>SCOPE OF IMPLEMENTATION</ObjectLabel>
              <h3>Team</h3>
              <p>The group performs work in Project. A Project can have many Teams.</p>
              <small>
                For example: <strong>Maintainer</strong>
              </small>
            </div>
          </article>
        </ScopeLevels>
        <Callout>
          <strong>Scope and permissions are two different things</strong>
          <p>
            Select a Project or Team that does not automatically grant additional permissions. If
            you don't see the expected data, check both the selected scope and the permissions
            granted.
          </p>
        </Callout>
      </Section>
      <Section
        id="doi-tuong-cong-viec"
        number="01.2"
        title="Work item types"
        lead="Start from a large goal, then divide it into components that can be assigned to the Team and specific tasks."
      >
        <WorkTree aria-label="Epic, Feature, User Story, Defect and Task relationship">
          <TreeRow level="epic">
            <article>
              <TypeChip type="epic" />
              <div>
                <h3>Epic</h3>
                <p>
                  Large goal at the Project level, used to group Features with the same result
                  direction.
                </p>
              </div>
            </article>
          </TreeRow>
          <TreeConnector />
          <TreeRow level="feature">
            <article>
              <TypeChip type="feature" />
              <div>
                <h3>Feature</h3>
                <p>
                  A product capability that can be deployed by the Team. Feature can belong to an
                  Epic.
                </p>
              </div>
            </article>
          </TreeRow>
          <TreeConnector shape="split" />
          <TreeRow level="work-item">
            <article>
              <TypeChip type="story" />
              <div>
                <h3>User Story</h3>
                <p>The need to bring value to users. US can be associated with a Feature.</p>
              </div>
            </article>
            <article>
              <TypeChip type="defect" />
              <div>
                <h3>Defect</h3>
                <p>
                  Error needs to be tracked and resolved. DE can be associated with a Feature and a
                  Parent Story.
                </p>
              </div>
            </article>
          </TreeRow>
          <TreeConnector shape="merge" />
          <TreeConnector />
          <TreeRow level="task">
            <article>
              <TypeChip type="task" />
              <div>
                <h3>Task</h3>
                <p>Specific implementation. Task is always a direct child of a US or DE.</p>
              </div>
            </article>
          </TreeRow>
        </WorkTree>
        <DefinitionGrid>
          <article>
            <strong>The entire string is not required</strong>
            <p>
              A US/DE may not have associated Feature; A Feature may not be part of Epic yet. Tasks
              always need a parent US or DE.
            </p>
          </article>
          <article>
            <strong>Do not use Epic instead of Project</strong>
            <p>Project is a scope containing data. Epic is the target audience within a Project.</p>
          </article>
          <article>
            <strong>US and DE are two peer types</strong>
            <p>
              Both are Work Items and can have child Tasks. DE has its own error handling lifecycle.
            </p>
          </article>
        </DefinitionGrid>
      </Section>
      <Section
        id="doi-tuong-ke-hoach"
        number="01.3"
        title="Three planning objects"
        lead="Iteration, Release, and Milestone add timing context to Work Items; they are not three consecutive parent–child levels."
      >
        <PlanningGrid>
          <article>
            <PlanningIcon />
            <h3>Iteration</h3>
            <p>
              Short working time for Team to perform a US/DE group. Work Items that have not yet
              entered Iteration are considered <strong>Unscheduled</strong> and is in the Backlog.
            </p>
            <PlanningQuestion>
              <span>Used to answer</span>
              <strong>What does Team do in this cycle?</strong>
            </PlanningQuestion>
          </article>
          <article>
            <PlanningIcon type="release" />
            <h3>Release</h3>
            <p>
              A delivery has its own time period and status. US/DE can be attached to a maximum of
              one Release.
            </p>
            <PlanningQuestion>
              <span>Used to answer</span>
              <strong>Which deliveries are the work aimed at?</strong>
            </PlanningQuestion>
          </article>
          <article>
            <PlanningIcon type="milestone" />
            <h3>Milestone</h3>
            <p>
              Important milestone to track. A Milestone can link multiple Releases and span multiple
              Projects or Teams.
            </p>
            <PlanningQuestion>
              <span>Used to answer</span>
              <strong>What important milestones need to be achieved?</strong>
            </PlanningQuestion>
          </article>
        </PlanningGrid>
        <Callout tone="warning">
          <strong>Don't read these planning objects as a tree</strong>
          <p>
            A US/DE can simultaneously belong to an Iteration, a Release and many Milestones. Each
            link serves a different management purpose.
          </p>
        </Callout>
      </Section>
      <Section
        id="quyen-va-trach-nhiem"
        number="01.4"
        title="Access rights and responsibilities"
        lead="Rova uses scope permissions. Role names such as PM, BA, Developer, or QA do not automatically determine which button you can use."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Permissions</th>
              <th>Scope</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Workspace Admin</strong>
              </td>
              <td>Complete Workspace</td>
              <td>
                Manage users, Projects, Teams and access rights. Team membership only determines
                participation in operations and the ability to be selected as an Owner in the Team.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Admin</strong>
              </td>
              <td>One Project · All Teams</td>
              <td>
                Manage delivery activities in the assigned Project; Do not self-administer the
                Workspace structure.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Editor</strong>
              </td>
              <td>A Project · assigned Teams</td>
              <td>
                Creating and updating tasks in Teams is allowed; Do not access out-of-scope planning
                or administrative functions.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Project not assigned</strong>
              </td>
              <td>No Project scope</td>
              <td>
                Project does not appear and direct path is denied. This is a state of lack of
                rights, not a right to choose.
              </td>
            </tr>
          </tbody>
        </DocTable>
        <Callout>
          <strong>Example of Workspace Admin and Owner</strong>
          <p>
            Workspace Admin can still create US/DE thanks to Workspace permissions. However, their
            name can only be selected as Owner when they are a valid member of the Team being
            selected.
          </p>
        </Callout>
      </Section>
      <Section
        id="vi-du-xuyen-suot"
        number="01.5"
        title="Scenario walkthrough"
        lead="This example will help you join scope, work, and plan without confusing them as a single structure."
      >
        <ScenarioCard>
          <ScenarioHead>
            <ScenarioBadge>EXAMPLE</ScenarioBadge>
            <div>
              <h3>Improved search experience</h3>
              <p>Team Maintainer prepares a search enhancement for the next delivery.</p>
            </div>
          </ScenarioHead>
          <ScenarioScope>
            <span>QNSC</span>
            <i>›</i>
            <span>Rova</span>
            <i>›</i>
            <strong>Maintainer</strong>
          </ScenarioScope>
          <ScenarioFlow>
            <li>
              <span>EP</span>
              <div>
                <strong>Epic: Enhance user experience</strong>
                <p>Big goal at Project level.</p>
              </div>
            </li>
            <li>
              <span>FE</span>
              <div>
                <strong>Feature: Advanced search</strong>
                <p>Product capabilities belong to Epic and are deployed by the Team.</p>
              </div>
            </li>
            <li>
              <span>US</span>
              <div>
                <strong>User Story: Filter results by Priority</strong>
                <p>Specific user needs, associated with Feature.</p>
              </div>
            </li>
            <li>
              <span>TA</span>
              <div>
                <strong>Task: Build Priority filter</strong>
                <p>The concrete implementation, is a child of the User Story.</p>
              </div>
            </li>
          </ScenarioFlow>
          <ScenarioPlanning>
            <div>
              <span>Iteration</span>
              <strong>Team cycle executes US</strong>
            </div>
            <div>
              <span>Release</span>
              <strong>Expected feature delivery</strong>
            </div>
            <div>
              <span>Milestone</span>
              <strong>Important demo or acceptance milestone</strong>
            </div>
          </ScenarioPlanning>
        </ScenarioCard>
        <CheckUnderstanding>
          <strong>Check yourself before moving on to the next section</strong>
          <ul>
            <li>Can you distinguish between Project and Epic?</li>
            <li>Do you know which US or DE the Task must belong to?</li>
            <li>Do you understand why selecting Team can change the Owner list?</li>
            <li>Did you know Iteration and Release answer two different questions?</li>
          </ul>
        </CheckUnderstanding>
      </Section>
    </>
  )
}
