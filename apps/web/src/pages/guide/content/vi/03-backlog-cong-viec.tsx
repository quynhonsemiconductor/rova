/*
 * Vietnamese edition, chapter 03-backlog-cong-viec (US-119). Converted from the BA's static page
 * `public/guide/03-backlog-cong-viec.html`.
 */
import { GuideShot } from '../../ui/guide-shot'
import {
  ActionGrid,
  Callout,
  ChapterEyebrow,
  ChapterIntro,
  ChapterSummary,
  CheckUnderstanding,
  DefectRoutes,
  DefinitionGrid,
  DetailGuide,
  DocTable,
  InstructionList,
  Lead,
  ResultBox,
  RouteCard,
  Section,
  TroubleshootList,
} from '../../ui/parts'

export default function Chapter() {
  return (
    <>
      <ChapterIntro id="chapter-03">
        <div>
          <ChapterEyebrow>PHẦN 03 · BACKLOG & CÔNG VIỆC</ChapterEyebrow>
          <h2>Tạo đúng loại công việc trong đúng phạm vi</h2>
          <Lead>
            Backlog là nơi tìm và quản lý <strong>User Story</strong> hoặc <strong>Defect</strong>{' '}
            chưa được đưa vào Iteration. Hãy kiểm tra Project, Team và Owner trước khi lưu.
          </Lead>
        </div>
        <ChapterSummary aria-label="Sau phần này bạn sẽ làm được">
          <strong>Sau phần này, bạn sẽ làm được</strong>
          <ul>
            <li>Tìm, lọc và đọc danh sách Backlog.</li>
            <li>Tạo User Story hoặc ghi nhận Defect.</li>
            <li>Chọn Team và Owner đúng điều kiện.</li>
            <li>Mở trang chi tiết để bổ sung thông tin và liên kết.</li>
            <li>Xử lý khi không thấy Work Item hoặc Owner cần chọn.</li>
          </ul>
        </ChapterSummary>
      </ChapterIntro>
      <Section
        id="doc-backlog"
        number="03.1"
        title="Đọc và tìm trong Backlog"
        lead="Backlog chỉ hiển thị User Story và Defect. Task được quản lý trong trang chi tiết của US hoặc DE cha."
      >
        <GuideShot
          name="03-backlog-production"
          alt="Backlog Rova với ô Search, nút Add New, Filters, Show Fields và bảng Work Item."
          caption="Màn hình Backlog và các công cụ tìm, lọc, tạo Work Item."
        />
        <ActionGrid>
          <article>
            <span>1</span>
            <div>
              <strong>Search</strong>
              <p>
                Nhập ID như <b>US-52</b>, <b>DE-12</b> hoặc một phần tiêu đề để thu hẹp danh sách.
              </p>
            </div>
          </article>
          <article>
            <span>2</span>
            <div>
              <strong>Filters</strong>
              <p>
                Lọc theo Type, Schedule State, Priority, Owner hoặc Release. Bỏ bộ lọc khi cần xem
                lại toàn bộ.
              </p>
            </div>
          </article>
          <article>
            <span>3</span>
            <div>
              <strong>Show Fields</strong>
              <p>
                Chọn các cột cần đọc. Các cột thường dùng gồm trạng thái, Priority, Estimate, Owner,
                Release và Iteration.
              </p>
            </div>
          </article>
          <article>
            <span>4</span>
            <div>
              <strong>Mở Work Item</strong>
              <p>
                Chọn ID trong bảng để mở trang chi tiết. Dùng Rows per page hoặc nút chuyển trang
                khi danh sách dài.
              </p>
            </div>
          </article>
        </ActionGrid>
        <Callout>
          <strong>Không thấy một Work Item chưa chắc là đã mất</strong>
          <p>
            Kiểm tra lại Project/Team, từ khóa, bộ lọc và trang hiện tại. Khi US/DE được gán vào
            Iteration, hãy tìm trong Iteration tương ứng thay vì danh sách Unscheduled của Backlog.
          </p>
        </Callout>
      </Section>
      <Section
        id="tao-user-story"
        number="03.2"
        title="Tạo User Story"
        lead="Dùng User Story cho một nhu cầu hoặc giá trị cần mang lại cho người dùng."
      >
        <GuideShot
          name="03-create-work-item-production"
          alt="Form New Work Item với lựa chọn Story hoặc Defect và các trường Title, Project, Team, Owner, Plan Estimate."
          caption="Form New Work Item và các trường cần điền."
        />
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Mở Plan → Backlog</strong>
              <p>Xác nhận đúng Project và Team trên context selector trước khi tiếp tục.</p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Chọn Add New</strong>
              <p>
                Form <b>New Work Item</b> mở với loại mặc định là <b>Story</b>.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Nhập thông tin ban đầu</strong>
              <p>
                Nhập <b>Title</b>; kiểm tra Project; chọn Team, Owner và Plan Estimate khi đã xác
                định.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Chọn cách lưu</strong>
              <p>
                <b>Create Item</b> tạo nhanh và trở về Backlog. <b>Create with details</b> tạo rồi
                mở trang chi tiết để nhập tiếp.
              </p>
            </div>
          </li>
        </InstructionList>
        <DocTable columns="fields">
          <thead>
            <tr>
              <th>Trường</th>
              <th>Bắt buộc</th>
              <th>Cách nhập</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Type</strong>
              </td>
              <td>Có</td>
              <td>
                Giữ <b>Story</b> khi tạo User Story.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Title</strong>
              </td>
              <td>Có</td>
              <td>Viết ngắn, mô tả rõ nhu cầu hoặc kết quả cần đạt.</td>
            </tr>
            <tr>
              <td>
                <strong>Project</strong>
              </td>
              <td>Có</td>
              <td>Rova lấy Project đang chọn; quay lại context selector nếu Project không đúng.</td>
            </tr>
            <tr>
              <td>
                <strong>Team</strong>
              </td>
              <td>Không</td>
              <td>
                Chọn Team thực hiện. Để <b>No team</b> nếu công việc mới ở Project Backlog.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Owner</strong>
              </td>
              <td>Không</td>
              <td>
                Rova điền người đang đăng nhập khi họ đủ điều kiện. Bạn có thể chọn người hợp lệ
                khác hoặc <b>— No Entry —</b>.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Plan Estimate</strong>
              </td>
              <td>Không</td>
              <td>Nhập số không âm; có thể để 0 khi chưa estimate.</td>
            </tr>
          </tbody>
        </DocTable>
        <ResultBox>
          <span>KẾT QUẢ MONG ĐỢI</span>{' '}
          <strong>User Story được tạo với ID mới và trạng thái Idea</strong>
          <p>
            Item xuất hiện trong Backlog của Project/Team phù hợp nếu chưa gán Iteration và không bị
            bộ lọc hiện tại che đi.
          </p>
        </ResultBox>
      </Section>
      <Section
        id="tao-defect"
        number="03.3"
        title="Ghi nhận Defect"
        lead="Dùng Defect khi hành vi thực tế sai so với kết quả mong đợi và cần được theo dõi xử lý."
      >
        <DefectRoutes>
          <RouteCard>
            <span>CÁCH 1 · GHI NHANH</span>
            <h3>Plan → Backlog → Add New</h3>
            <p>
              Chọn loại <b>Defect</b>, nhập Title, kiểm tra Project rồi chọn Team, Owner, Estimate
              và Parent Story nếu đã biết.
            </p>
            <strong>Dùng khi:</strong>
            <p>Bạn đang làm việc trong Backlog và cần ghi nhận lỗi nhanh.</p>
          </RouteCard>
          <RouteCard quality>
            <span>CÁCH 2 · GHI NHẬN CHẤT LƯỢNG</span>
            <h3>Quality → Defects → Add New</h3>
            <p>
              Nhập Title, Description, Severity, Priority, Found In và Root Cause; sau đó chọn
              Assignee, Release và User Story nếu phù hợp.
            </p>
            <strong>Dùng khi:</strong>
            <p>Bạn cần mô tả và phân loại lỗi ngay từ đầu.</p>
          </RouteCard>
        </DefectRoutes>
        <GuideShot
          name="03-quality-defects-production"
          alt="Form Add New Defect trong Quality với các trường Title, Description, Severity, Priority, Found In, Root Cause, Assignee, Release và User Story."
          caption="Form Quality → Defects → Add New và các trường mô tả lỗi."
        />
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Mở Quality → Defects</strong>
              <p>
                Xác nhận đúng Project và Team trên context selector, rồi chọn <b>Add New</b>.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Mô tả lỗi</strong>
              <p>
                Title nêu rõ biểu hiện; Description ghi bước tái hiện, kết quả mong đợi và kết quả
                thực tế.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Phân loại</strong>
              <p>
                Chọn Severity, Priority, Found In và Root Cause theo thông tin hiện có. Có thể bổ
                sung sau nếu chưa xác định.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Liên kết và lưu</strong>
              <p>
                Chọn Assignee, Release và User Story khi phù hợp. User Story là liên kết cha tùy
                chọn trong cùng Project.
              </p>
            </div>
          </li>
        </InstructionList>
        <ResultBox>
          <span>KẾT QUẢ MONG ĐỢI</span>{' '}
          <strong>Hai đường tạo cùng sinh ra một Defect dùng chung</strong>
          <p>
            Defect có thể được mở từ Backlog hoặc Quality theo phạm vi và bộ lọc hiện tại. Đây là
            cùng một bản ghi, không cần tạo lại ở màn hình còn lại.
          </p>
        </ResultBox>
        <Callout tone="warning">
          <strong>Đừng dùng Defect thay cho Task</strong>
          <p>
            Defect ghi nhận lỗi cần theo dõi. Task là việc thực hiện cụ thể và chỉ được tạo trong
            tab <b>Tasks</b> của một US hoặc DE cha.
          </p>
        </Callout>
      </Section>
      <Section
        id="chon-team-owner"
        number="03.4"
        title="Chọn Team và Owner đúng điều kiện"
        lead="Quyền tạo Work Item và điều kiện xuất hiện trong danh sách Owner là hai việc khác nhau."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Người dùng</th>
              <th>Khi nào xuất hiện trong Owner</th>
              <th>Cách xử lý</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Admin của Project</strong>
              </td>
              <td>Có thể được chọn trong phạm vi Project.</td>
              <td>Chọn đúng Project; Team không giới hạn quyền quản lý Project của Admin.</td>
            </tr>
            <tr>
              <td>
                <strong>Editor</strong>
              </td>
              <td>Chỉ trong Team đang chọn mà họ được gán.</td>
              <td>Chọn Team trước, rồi mở lại danh sách Owner.</td>
            </tr>
            <tr>
              <td>
                <strong>Workspace Admin</strong>
              </td>
              <td>Chỉ khi là member hợp lệ của Team đang chọn.</td>
              <td>Họ vẫn có thể tạo US/DE bằng quyền Workspace dù tên không có trong Owner.</td>
            </tr>
            <tr>
              <td>
                <strong>— No Entry —</strong>
              </td>
              <td>Luôn có thể chọn.</td>
              <td>Dùng khi chưa xác định người chịu trách nhiệm; phân công lại sau.</td>
            </tr>
          </tbody>
        </DocTable>
        <DefinitionGrid>
          <article>
            <strong>No team</strong>
            <p>
              Item nằm ở Project Backlog. Editor hoặc Workspace Admin là Team member thường không
              được đưa vào Owner khi chưa chọn Team.
            </p>
          </article>
          <article>
            <strong>All Teams</strong>
            <p>Đây là phạm vi xem của Admin, không phải một Team để gán cho Work Item.</p>
          </article>
          <article>
            <strong>Owner và Dev Owner</strong>
            <p>
              Hai trường độc lập nhưng dùng cùng nguồn người đủ điều kiện. Có thể để trống và chọn
              hai người khác nhau.
            </p>
          </article>
        </DefinitionGrid>
      </Section>
      <Section
        id="cap-nhat-work-item"
        number="03.5"
        title="Cập nhật và liên kết Work Item"
        lead="Mở ID từ Backlog để bổ sung thông tin không có trong form tạo nhanh."
      >
        <DetailGuide>
          <article>
            <span>01</span>
            <h3>Mở trang chi tiết</h3>
            <p>
              Chọn ID của US hoặc DE. Các tab đang dùng gồm <b>Details</b>, <b>Tasks</b>,{' '}
              <b>Connections</b> và <b>Revision History</b>.
            </p>
          </article>
          <article>
            <span>02</span>
            <h3>Bổ sung nội dung</h3>
            <p>
              Cập nhật Title, Description, Notes, Release Notes, Comments, Attachments hoặc Linked
              Items khi cần.
            </p>
          </article>
          <article>
            <span>03</span>
            <h3>Gán kế hoạch và trách nhiệm</h3>
            <p>
              Chọn Schedule State, Flow State, Owner, Dev Owner, Team, Estimate, Iteration, Release
              và Milestones. Defect có thêm Priority.
            </p>
          </article>
          <article>
            <span>05</span>
            <h3>Liên kết đúng cấp</h3>
            <p>
              US/DE có thể liên kết Feature. Defect có thể chọn thêm Parent Story. Task được tạo
              trong tab Tasks của US hoặc DE cha.
            </p>
          </article>
        </DetailGuide>
        <Callout tone="warning">
          <strong>Kiểm tra lại Owner sau khi đổi Team</strong>
          <p>
            Owner hoặc Dev Owner cũ có thể không còn hợp lệ trong Team mới. Chọn lại người phù hợp
            hoặc để <b>— No Entry —</b> trước khi tiếp tục.
          </p>
        </Callout>
      </Section>
      <Section
        id="xu-ly-backlog"
        number="03.6"
        title="Xử lý tình huống thường gặp"
        lead="Kiểm tra theo thứ tự dưới đây trước khi tạo lại hoặc nhờ người khác can thiệp."
      >
        <TroubleshootList>
          <article>
            <span>01</span>
            <div>
              <strong>Không tìm thấy US/DE</strong>
              <p>
                Kiểm tra context selector, xóa Search và Filters, xem trang tiếp theo, rồi kiểm tra
                item đã vào Iteration chưa.
              </p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <strong>Không thấy người cần chọn</strong>
              <p>
                Chọn đúng Team và kiểm tra membership. Nếu chưa đủ điều kiện, giữ{' '}
                <b>— No Entry —</b> và nhờ Workspace Admin cập nhật Team.
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <strong>Nút tạo chưa bật</strong>
              <p>
                Đảm bảo đã chọn Story hoặc Defect, nhập Title và đang ở Project bạn có quyền tạo
                Work Item.
              </p>
            </div>
          </article>
          <article>
            <span>05</span>
            <div>
              <strong>Item vừa tạo không còn trong danh sách</strong>
              <p>
                Xóa bộ lọc, kiểm tra Project/Team và Iteration. Item đã vào Iteration sẽ không còn ở
                danh sách Backlog chưa lập lịch.
              </p>
            </div>
          </article>
        </TroubleshootList>
        <CheckUnderstanding>
          <strong>Tự kiểm tra trước khi sang phần tiếp theo</strong>
          <ul>
            <li>Bạn đã chọn đúng Project và Team chưa?</li>
            <li>Bạn đang tạo User Story hay Defect?</li>
            <li>Owner có đủ điều kiện trong Team đang chọn không?</li>
            <li>Bạn biết khi nào cần mở trang chi tiết chưa?</li>
          </ul>
        </CheckUnderstanding>
      </Section>
    </>
  )
}
