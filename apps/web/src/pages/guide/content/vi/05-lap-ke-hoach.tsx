/*
 * Vietnamese edition, chapter 05-lap-ke-hoach (US-119). Converted from the BA's static page
 * `public/guide/05-lap-ke-hoach.html`.
 */
import { GuideShot } from '../../ui/guide-shot'
import {
  ActionGrid,
  Callout,
  ChapterEyebrow,
  ChapterIntro,
  ChapterSummary,
  CheckUnderstanding,
  DocTable,
  InstructionList,
  IterationChangeGrid,
  IterationStateCard,
  IterationStateFlow,
  Lead,
  ResultBox,
  Section,
  TaskPrereq,
  TroubleshootList,
} from '../../ui/parts'

export default function Chapter() {
  return (
    <>
      <ChapterIntro id="chapter-05">
        <div>
          <ChapterEyebrow>PHẦN 05 · LẬP KẾ HOẠCH</ChapterEyebrow>
          <h2>Lập kế hoạch một Iteration có phạm vi rõ ràng</h2>
          <Lead>
            <strong>Iteration</strong> là chu kỳ ngắn để Team thực hiện một nhóm User Story và
            Defect. Hãy tạo Iteration đúng Project, đặt <strong>Planned Velocity</strong>, rồi đưa
            từng Work Item từ trạng thái <strong>Unscheduled</strong> vào chu kỳ phù hợp.
          </Lead>
        </div>
        <ChapterSummary aria-label="Sau phần này bạn sẽ làm được">
          <strong>Sau phần này, bạn sẽ làm được</strong>
          <ul>
            <li>Đọc danh sách và trạng thái Iteration.</li>
            <li>Tạo Iteration đúng Project và Team.</li>
            <li>Đặt Planned Velocity theo số Points Team dự kiến hoàn thành.</li>
            <li>Đưa US/DE vào một Iteration.</li>
            <li>Đổi Iteration hoặc trả item về Unscheduled.</li>
            <li>Xử lý các lỗi phạm vi và dữ liệu thường gặp.</li>
          </ul>
        </ChapterSummary>
      </ChapterIntro>
      <Section
        id="doc-timeboxes"
        number="05.1"
        title="Đọc danh sách Iteration"
        lead={
          <>
            Vào <b>Plan → Timeboxes</b> và chọn <b>Iterations</b> để xem các chu kỳ của Project hiện
            tại.
          </>
        }
      >
        <GuideShot
          name="04-timeboxes-production"
          alt="Danh sách Iterations với bộ chọn Timebox, số liệu tổng hợp, Search, Add New, Filters, Show Fields và bảng Iteration."
          caption="Màn hình Plan → Timeboxes và danh sách Iteration."
        />
        <ActionGrid>
          <article>
            <span>1</span>
            <div>
              <strong>Chọn loại Timebox</strong>
              <p>Dùng danh sách cạnh tiêu đề để chuyển giữa Iterations, Releases và Milestones.</p>
            </div>
          </article>
          <article>
            <span>2</span>
            <div>
              <strong>Đọc số liệu tổng hợp</strong>
              <p>
                Total là tổng số; Planning, Committed và Accepted là số Iteration theo từng trạng
                thái.
              </p>
            </div>
          </article>
          <article>
            <span>3</span>
            <div>
              <strong>Tìm và lọc</strong>
              <p>
                Dùng Search, Filters và Show Fields để thu hẹp danh sách hoặc chọn các cột cần đọc.
              </p>
            </div>
          </article>
          <article>
            <span>4</span>
            <div>
              <strong>Mở Iteration</strong>
              <p>
                Chọn ID để xem chi tiết. Các cột chính gồm ngày bắt đầu, ngày kết thúc, Planned
                Velocity, Task Estimate và State.
              </p>
            </div>
          </article>
        </ActionGrid>
        <Callout>
          <strong>Đừng nhầm hai loại trạng thái</strong>
          <p>
            <b>Iteration State</b> cho biết chu kỳ đang Planning, Committed hay Accepted. Schedule
            State và Flow State cho biết tiến độ của từng US/DE bên trong.
          </p>
        </Callout>
      </Section>
      <Section
        id="tao-iteration"
        number="05.2"
        title="Tạo Iteration"
        lead="Workspace Admin hoặc Project Admin tạo chu kỳ cho Project đang chọn. Team có thể để trống nếu Iteration dùng ở cấp Project."
      >
        <GuideShot
          name="04-create-iteration-production"
          alt="Form New Iteration với các trường Name, Project, Team, Start Date, End Date và State."
          caption="Form New Iteration và các trường cần điền."
        />
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Kiểm tra Project</strong>
              <p>
                Project trên form lấy từ context hiện tại và không sửa trực tiếp. Đổi context trước
                nếu Project chưa đúng.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Mở form tạo</strong>
              <p>
                Vào <b>Plan → Timeboxes</b>, chọn <b>Iterations</b>, rồi chọn <b>Add New</b>.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Nhập phạm vi và thời gian</strong>
              <p>
                Nhập Name; chọn Team nếu cần; chọn Start Date, End Date và State. Ngày bắt đầu không
                được sau ngày kết thúc.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Chọn cách lưu</strong>
              <p>
                <b>Create Iteration</b> tạo nhanh. <b>Create with details</b> tạo rồi mở trang chi
                tiết để bổ sung thông tin.
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
                <strong>Name</strong>
              </td>
              <td>Có</td>
              <td>Dùng tên ngắn, dễ nhận biết chu kỳ hoặc khoảng thời gian.</td>
            </tr>
            <tr>
              <td>
                <strong>Project</strong>
              </td>
              <td>Có</td>
              <td>Rova lấy Project hiện tại. Muốn đổi Project, đóng form và đổi context.</td>
            </tr>
            <tr>
              <td>
                <strong>Team</strong>
              </td>
              <td>Không</td>
              <td>
                Chọn Team thuộc Project; để <b>No team</b> nếu Iteration áp dụng ở cấp Project.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Start / End Date</strong>
              </td>
              <td>Có</td>
              <td>Chọn khoảng thực hiện hợp lệ; Start Date phải trước hoặc bằng End Date.</td>
            </tr>
            <tr>
              <td>
                <strong>State</strong>
              </td>
              <td>Có</td>
              <td>
                Iteration mới thường bắt đầu ở <b>Planning</b>.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Planned Velocity</strong>
              </td>
              <td>Không</td>
              <td>
                Không có trong form tạo nhanh. Chọn <b>Create with details</b> hoặc mở Iteration sau
                khi tạo để nhập số Points dự kiến.
              </td>
            </tr>
          </tbody>
        </DocTable>
      </Section>
      <Section
        id="lap-planned-velocity"
        number="05.3"
        title="Lập Planned Velocity"
        lead="Planned Velocity là số Points Team dự kiến hoàn thành trong Iteration. Đây là mục tiêu kế hoạch được nhập thủ công, không phải số giờ Task."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Mở Iteration Detail</strong>
              <p>
                Trong <b>Plan → Timeboxes → Iterations</b>, chọn ID của Iteration. Nếu đang tạo mới,
                chọn <b>Create with details</b>.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Tìm trường Planned Velocity</strong>
              <p>
                Trường này nằm trong vùng <b>Details</b> bên phải, cùng Start Date, End Date và
                State.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Nhập số Points dự kiến</strong>
              <p>
                Dùng số từ 0 trở lên. Có thể để trống nếu Team chưa chốt kế hoạch; không nhập số giờ
                Capacity hoặc Task Estimate vào đây.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Kiểm tra kết quả</strong>
              <p>
                Quay lại danh sách Iterations và xác nhận giá trị ở cột <b>Planned Velocity</b>. Khi
                mở chi tiết, khu vực Capacity cũng hiển thị mục tiêu này.
              </p>
            </div>
          </li>
        </InstructionList>
        <DocTable columns="fields">
          <thead>
            <tr>
              <th>Chỉ số</th>
              <th>Đơn vị</th>
              <th>Cách dùng</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Planned Velocity</strong>
              </td>
              <td>Points</td>
              <td>Mục tiêu Team dự kiến hoàn thành trong Iteration; nhập thủ công.</td>
            </tr>
            <tr>
              <td>
                <strong>Committed</strong>
              </td>
              <td>Points</td>
              <td>
                Tổng Estimate của US/DE đang nằm trong phạm vi Iteration; dùng để so với kế hoạch.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Accepted</strong>
              </td>
              <td>Points</td>
              <td>Tổng Estimate đã Accepted; dùng để theo dõi kết quả thực tế của chu kỳ.</td>
            </tr>
            <tr>
              <td>
                <strong>Task Estimate</strong>
              </td>
              <td>Giờ</td>
              <td>
                Tổng Estimate của các Task; là chỉ số effort riêng và không thay thế Planned
                Velocity.
              </td>
            </tr>
          </tbody>
        </DocTable>
        <Callout>
          <strong>Cách chọn con số ban đầu</strong>
          <p>
            Tham khảo Velocity của các Iteration đã hoàn thành, số thành viên có thể tham gia và
            phạm vi US/DE dự kiến. Planned Velocity không tự đổi khi bạn thêm hoặc chuyển Work Item,
            vì vậy hãy cập nhật lại nếu Team thay đổi cam kết.
          </p>
        </Callout>
      </Section>
      <Section
        id="gan-cong-viec-iteration"
        number="05.4"
        title="Đưa công việc vào Iteration"
        lead="Một User Story hoặc Defect chỉ thuộc tối đa một Iteration tại một thời điểm."
      >
        <TaskPrereq>
          <span>TRƯỚC KHI GÁN</span> <strong>Kiểm tra ba điều</strong>
          <ul>
            <li>US/DE và Iteration cùng Project.</li>
            <li>Team của hai bên phù hợp.</li>
            <li>Bạn có quyền cập nhật Work Item.</li>
          </ul>
        </TaskPrereq>
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Mở Work Item</strong>
              <p>
                Từ <b>Plan → Backlog</b>, chọn ID của User Story hoặc Defect cần lập kế hoạch.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Chọn trường Iteration</strong>
              <p>Mở danh sách và chọn Iteration phù hợp trong cùng Project/Team.</p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Lưu thay đổi</strong>
              <p>Rova cập nhật chính Work Item hiện có; không tạo thêm bản sao.</p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Kiểm tra kết quả</strong>
              <p>
                Item rời danh sách Backlog chưa lập lịch và xuất hiện trong{' '}
                <b>Track → Iteration Status</b> của chu kỳ đã chọn.
              </p>
            </div>
          </li>
        </InstructionList>
        <Callout>
          <strong>Task đi theo US hoặc Defect cha</strong>
          <p>
            Không gán Task vào Iteration riêng. Task kế thừa Iteration của Work Item cha và được
            theo dõi cùng chu kỳ đó.
          </p>
        </Callout>
      </Section>
      <Section
        id="doi-iteration"
        number="05.5"
        title="Đổi Iteration hoặc trả về Unscheduled"
        lead="Thay đổi trường Iteration trên Work Item; không xóa và tạo lại item."
      >
        <IterationChangeGrid>
          <article>
            <span>CHUYỂN CHU KỲ</span>
            <h3>Chọn một Iteration khác</h3>
            <p>
              Work Item rời Iteration cũ và xuất hiện trong Iteration mới. ID, nội dung và lịch sử
              của item được giữ nguyên.
            </p>
          </article>
          <article>
            <span>TRẢ VỀ BACKLOG</span>
            <h3>Chọn Unscheduled</h3>
            <p>
              Work Item không còn thuộc Iteration và xuất hiện lại trong Backlog chưa lập lịch, nếu
              không bị Search hoặc Filters che đi.
            </p>
          </article>
        </IterationChangeGrid>
        <ResultBox>
          <span>KẾT QUẢ MONG ĐỢI</span>{' '}
          <strong>Mỗi lần lưu chỉ có một phạm vi lập kế hoạch hiện hành</strong>
          <p>
            Hãy kiểm tra lại Backlog hoặc Track → Iteration Status sau khi đổi để chắc rằng item nằm
            đúng nơi.
          </p>
        </ResultBox>
      </Section>
      <Section
        id="trang-thai-iteration"
        number="05.6"
        title="Cập nhật trạng thái Iteration"
        lead="Trạng thái phản ánh mức độ cam kết của cả chu kỳ, không tự thay đổi chỉ vì bạn thêm một Work Item."
      >
        <IterationStateFlow aria-label="Ba trạng thái của Iteration">
          <IterationStateCard state="planning">
            <span>01</span>
            <h3>Planning</h3>
            <p>
              Đang chuẩn bị phạm vi, thời gian và công việc. Đây là trạng thái khởi tạo thông
              thường.
            </p>
          </IterationStateCard>
          <IterationStateCard state="committed">
            <span>02</span>
            <h3>Committed</h3>
            <p>
              Team đã cam kết chu kỳ. Chuyển trạng thái thủ công; phạm vi vẫn có thể được điều
              chỉnh.
            </p>
          </IterationStateCard>
          <IterationStateCard state="accepted">
            <span>03</span>
            <h3>Accepted</h3>
            <p>
              Chu kỳ đã hoàn tất nghiệm thu. Khi Iteration có công việc và toàn bộ US/DE đều
              Accepted, Rova có thể cập nhật trạng thái này.
            </p>
          </IterationStateCard>
        </IterationStateFlow>
        <Callout tone="warning">
          <strong>Accepted không tự quay lùi</strong>
          <p>
            Nếu một Work Item được mở lại sau đó, hãy kiểm tra và cập nhật Iteration theo quy trình
            của Team. Đừng dựa vào thay đổi tự động ngược.
          </p>
        </Callout>
      </Section>
      <Section
        id="xu-ly-iteration"
        number="05.7"
        title="Xử lý tình huống thường gặp"
        lead="Kiểm tra phạm vi, quyền và dữ liệu trước khi tạo lại Iteration hoặc Work Item."
      >
        <TroubleshootList>
          <article>
            <span>01</span>
            <div>
              <strong>Không thấy Plan → Timeboxes</strong>
              <p>
                Kiểm tra đúng Project và quyền. Chức năng tạo, quản lý Iteration dành cho Workspace
                Admin hoặc Project Admin.
              </p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <strong>Không thấy Iteration cần chọn</strong>
              <p>
                Kiểm tra Project hiện tại và Team của Work Item. Danh sách chỉ đưa ra Iteration phù
                hợp với phạm vi.
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <strong>Không lưu được Iteration</strong>
              <p>
                Kiểm tra Name, Start Date, End Date và State; bảo đảm ngày bắt đầu không sau ngày
                kết thúc.
              </p>
            </div>
          </article>
          <article>
            <span>05</span>
            <div>
              <strong>Work Item biến mất khỏi Backlog</strong>
              <p>
                Đây là kết quả bình thường sau khi gán Iteration. Mở <b>Track → Iteration Status</b>{' '}
                để tìm trong chu kỳ tương ứng.
              </p>
            </div>
          </article>
          <article>
            <span>06</span>
            <div>
              <strong>Không gán được Work Item</strong>
              <p>
                Iteration và Work Item có thể đang khác Project hoặc Team. Sửa phạm vi cho phù hợp
                rồi thử lại.
              </p>
            </div>
          </article>
          <article>
            <span>07</span>
            <div>
              <strong>Trạng thái không như dự kiến</strong>
              <p>
                Kiểm tra bạn đang đọc Iteration State hay trạng thái của Work Item. Gán thêm item
                không tự chuyển Iteration sang Committed.
              </p>
            </div>
          </article>
          <article>
            <span>08</span>
            <div>
              <strong>Planned Velocity không đổi sau khi thêm item</strong>
              <p>
                Đây là giá trị kế hoạch nhập thủ công. Mở Iteration Detail và cập nhật lại nếu Team
                thay đổi mục tiêu; đừng dùng Task Estimate theo giờ để thay thế.
              </p>
            </div>
          </article>
        </TroubleshootList>
        <CheckUnderstanding>
          <strong>Tự kiểm tra trước khi sang phần tiếp theo</strong>
          <ul>
            <li>Bạn đã chọn đúng Project và Team chưa?</li>
            <li>Iteration có khoảng ngày hợp lệ chưa?</li>
            <li>Planned Velocity đã dùng đúng đơn vị Points chưa?</li>
            <li>US/DE đang ở Iteration hay Unscheduled?</li>
            <li>Bạn có phân biệt Iteration State và trạng thái Work Item không?</li>
          </ul>
        </CheckUnderstanding>
      </Section>
    </>
  )
}
