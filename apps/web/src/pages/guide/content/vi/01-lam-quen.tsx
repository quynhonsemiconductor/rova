/*
 * Vietnamese edition, chapter 01-lam-quen. Converted from the BA's static guide
 * (`public/guide/01-lam-quen.html`); this file is the source of truth now.
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
          <ChapterEyebrow>PHẦN 01 · LÀM QUEN</ChapterEyebrow>
          <h2>Hiểu cấu trúc trước khi bắt đầu làm việc</h2>
          <Lead>
            Rova tổ chức dữ liệu theo ba lớp phạm vi:{' '}
            <ScopeLeadPath>Workspace → Project → Team</ScopeLeadPath>{' '}
            <ScopeLeadFollow>
              Sau đó, hệ thống dùng các loại đối tượng khác nhau để mô tả mục tiêu, công việc và kế
              hoạch giao hàng.
            </ScopeLeadFollow>
          </Lead>
        </div>
        <ChapterSummary aria-label="Sau phần này bạn sẽ hiểu">
          <strong>Sau phần này, bạn sẽ hiểu</strong>
          <ul>
            <li>Mình đang làm trong phạm vi nào.</li>
            <li>Epic, Feature, US, DE và Task khác nhau ra sao.</li>
            <li>Iteration, Release và Milestone dùng vào việc gì.</li>
            <li>Quyền truy cập khác với người tạo và Owner thế nào.</li>
          </ul>
        </ChapterSummary>
      </ChapterIntro>
      <Section
        id="pham-vi-lam-viec"
        number="01.1"
        title="Ba lớp phạm vi làm việc"
        lead="Phạm vi đang chọn quyết định dữ liệu bạn nhìn thấy và người có thể được chọn cho công việc."
      >
        <ScopeLevels aria-label="Cấu trúc Workspace, Project và Team">
          <article>
            <ScopeLevel>01</ScopeLevel>
            <div>
              <ObjectLabel>PHẠM VI CÔNG TY</ObjectLabel>
              <h3>Workspace</h3>
              <p>Không gian chung của tổ chức. Workspace chứa người dùng và các Project.</p>
              <small>
                Ví dụ: <strong>QNSC</strong>
              </small>
            </div>
          </article>
          <article>
            <ScopeLevel>02</ScopeLevel>
            <div>
              <ObjectLabel>PHẠM VI SẢN PHẨM</ObjectLabel>
              <h3>Project</h3>
              <p>Nơi tập hợp công việc, kế hoạch và báo cáo của một sản phẩm hoặc sáng kiến.</p>
              <small>
                Ví dụ: <strong>Rova</strong>
              </small>
            </div>
          </article>
          <article>
            <ScopeLevel>03</ScopeLevel>
            <div>
              <ObjectLabel>PHẠM VI THỰC HIỆN</ObjectLabel>
              <h3>Team</h3>
              <p>Nhóm thực hiện công việc trong Project. Một Project có thể có nhiều Team.</p>
              <small>
                Ví dụ: <strong>Maintainer</strong>
              </small>
            </div>
          </article>
        </ScopeLevels>
        <Callout>
          <strong>Phạm vi và quyền là hai việc khác nhau</strong>
          <p>
            Chọn một Project hoặc Team không tự cấp thêm quyền. Nếu không thấy dữ liệu mong đợi, hãy
            kiểm tra cả phạm vi đang chọn và quyền được cấp.
          </p>
        </Callout>
      </Section>
      <Section
        id="doi-tuong-cong-viec"
        number="01.2"
        title="Các loại đối tượng công việc"
        lead="Bắt đầu từ mức mục tiêu lớn, rồi chia thành phần có thể giao cho Team và công việc cụ thể."
      >
        <WorkTree aria-label="Quan hệ Epic, Feature, User Story, Defect và Task">
          <TreeRow level="epic">
            <article>
              <TypeChip type="epic" />
              <div>
                <h3>Epic</h3>
                <p>Mục tiêu lớn ở cấp Project, dùng để nhóm các Feature có cùng hướng kết quả.</p>
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
                  Một năng lực sản phẩm có thể được Team triển khai. Feature có thể thuộc một Epic.
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
                <p>Nhu cầu mang lại giá trị cho người dùng. US có thể liên kết với một Feature.</p>
              </div>
            </article>
            <article>
              <TypeChip type="defect" />
              <div>
                <h3>Defect</h3>
                <p>
                  Lỗi cần được theo dõi và xử lý. DE có thể liên kết với một Feature và một Parent
                  Story.
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
                <p>Việc thực hiện cụ thể. Task luôn là con trực tiếp của một US hoặc DE.</p>
              </div>
            </article>
          </TreeRow>
        </WorkTree>
        <DefinitionGrid>
          <article>
            <strong>Không bắt buộc đủ cả chuỗi</strong>
            <p>
              Một US/DE có thể chưa liên kết Feature; một Feature có thể chưa thuộc Epic. Riêng Task
              luôn cần một US hoặc DE cha.
            </p>
          </article>
          <article>
            <strong>Không dùng Epic thay cho Project</strong>
            <p>
              Project là phạm vi chứa dữ liệu. Epic là đối tượng mục tiêu nằm bên trong một Project.
            </p>
          </article>
          <article>
            <strong>US và DE là hai loại ngang hàng</strong>
            <p>
              Cả hai đều là Work Item và có thể có Task con. DE có thêm vòng đời xử lý lỗi riêng.
            </p>
          </article>
        </DefinitionGrid>
      </Section>
      <Section
        id="doi-tuong-ke-hoach"
        number="01.3"
        title="Ba đối tượng lập kế hoạch"
        lead="Iteration, Release và Milestone bổ sung ngữ cảnh thời gian cho công việc; chúng không phải ba cấp cha–con liên tiếp."
      >
        <PlanningGrid>
          <article>
            <PlanningIcon />
            <h3>Iteration</h3>
            <p>
              Khoảng làm việc ngắn để Team thực hiện một nhóm US/DE. Work Item chưa vào Iteration
              được xem là <strong>Unscheduled</strong> và nằm trong Backlog.
            </p>
            <PlanningQuestion>
              <span>Dùng để trả lời</span>
              <strong>Team làm gì trong chu kỳ này?</strong>
            </PlanningQuestion>
          </article>
          <article>
            <PlanningIcon type="release" />
            <h3>Release</h3>
            <p>
              Đợt giao hàng có khoảng thời gian và trạng thái riêng. US/DE có thể được gắn tối đa
              một Release.
            </p>
            <PlanningQuestion>
              <span>Dùng để trả lời</span>
              <strong>Công việc hướng tới đợt giao hàng nào?</strong>
            </PlanningQuestion>
          </article>
          <article>
            <PlanningIcon type="milestone" />
            <h3>Milestone</h3>
            <p>
              Mốc quan trọng cần theo dõi. Một Milestone có thể liên kết nhiều Release và trải rộng
              qua nhiều Project hoặc Team.
            </p>
            <PlanningQuestion>
              <span>Dùng để trả lời</span>
              <strong>Mốc kết quả quan trọng nào cần đạt?</strong>
            </PlanningQuestion>
          </article>
        </PlanningGrid>
        <Callout tone="warning">
          <strong>Đừng đọc ba đối tượng này như một cây</strong>
          <p>
            Một US/DE có thể đồng thời thuộc một Iteration, một Release và nhiều Milestone. Mỗi liên
            kết phục vụ một mục đích quản lý khác nhau.
          </p>
        </Callout>
      </Section>
      <Section
        id="quyen-va-trach-nhiem"
        number="01.4"
        title="Quyền truy cập và trách nhiệm"
        lead="Rova dùng quyền theo phạm vi. Tên công việc như PM, BA, Developer hoặc QA không tự quyết định nút bạn được dùng."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Quyền</th>
              <th>Phạm vi</th>
              <th>Miêu tả</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Workspace Admin</strong>
              </td>
              <td>Toàn Workspace</td>
              <td>
                Quản lý người dùng, Project, Team và quyền truy cập. Team membership chỉ quyết định
                việc tham gia vận hành và khả năng được chọn làm Owner trong Team.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Admin</strong>
              </td>
              <td>Một Project · All Teams</td>
              <td>
                Quản lý hoạt động delivery trong Project được cấp; không tự quản trị cấu trúc
                Workspace.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Editor</strong>
              </td>
              <td>Một Project · các Team được gán</td>
              <td>
                Tạo và cập nhật công việc trong Team được phép; không truy cập các chức năng lập kế
                hoạch hoặc quản trị ngoài phạm vi.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Không được gán Project</strong>
              </td>
              <td>Không có phạm vi Project</td>
              <td>
                Project không xuất hiện và đường dẫn trực tiếp bị từ chối. Đây là trạng thái thiếu
                quyền, không phải một quyền để chọn.
              </td>
            </tr>
          </tbody>
        </DocTable>
        <Callout>
          <strong>Ví dụ về Workspace Admin và Owner</strong>
          <p>
            Workspace Admin vẫn có thể tạo US/DE nhờ quyền Workspace. Tuy nhiên, tên của họ chỉ được
            chọn làm Owner khi họ là member hợp lệ của Team đang chọn.
          </p>
        </Callout>
      </Section>
      <Section
        id="vi-du-xuyen-suot"
        number="01.5"
        title="Mô phỏng tình huống"
        lead="Ví dụ này sẽ giúp bạn nối phạm vi, công việc và kế hoạch mà không nhầm chúng là một cấu trúc duy nhất."
      >
        <ScenarioCard>
          <ScenarioHead>
            <ScenarioBadge>VÍ DỤ</ScenarioBadge>
            <div>
              <h3>Cải thiện trải nghiệm tìm kiếm</h3>
              <p>Team Maintainer chuẩn bị một cải tiến tìm kiếm cho đợt giao hàng tiếp theo.</p>
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
                <strong>Epic: Nâng cao trải nghiệm người dùng</strong>
                <p>Mục tiêu lớn ở cấp Project.</p>
              </div>
            </li>
            <li>
              <span>FE</span>
              <div>
                <strong>Feature: Tìm kiếm nâng cao</strong>
                <p>Năng lực sản phẩm thuộc Epic và được Team triển khai.</p>
              </div>
            </li>
            <li>
              <span>US</span>
              <div>
                <strong>User Story: Lọc kết quả theo Priority</strong>
                <p>Nhu cầu cụ thể của người dùng, liên kết với Feature.</p>
              </div>
            </li>
            <li>
              <span>TA</span>
              <div>
                <strong>Task: Xây dựng bộ lọc Priority</strong>
                <p>Việc thực hiện cụ thể, là con của User Story.</p>
              </div>
            </li>
          </ScenarioFlow>
          <ScenarioPlanning>
            <div>
              <span>Iteration</span>
              <strong>Chu kỳ Team thực hiện US</strong>
            </div>
            <div>
              <span>Release</span>
              <strong>Đợt dự kiến giao tính năng</strong>
            </div>
            <div>
              <span>Milestone</span>
              <strong>Mốc demo hoặc nghiệm thu quan trọng</strong>
            </div>
          </ScenarioPlanning>
        </ScenarioCard>
        <CheckUnderstanding>
          <strong>Tự kiểm tra trước khi sang phần tiếp theo</strong>
          <ul>
            <li>Bạn phân biệt được Project với Epic chưa?</li>
            <li>Bạn biết Task phải thuộc US hoặc DE nào chưa?</li>
            <li>Bạn hiểu vì sao chọn Team có thể làm danh sách Owner thay đổi chưa?</li>
            <li>Bạn biết Iteration và Release trả lời hai câu hỏi khác nhau chưa?</li>
          </ul>
        </CheckUnderstanding>
      </Section>
    </>
  )
}
